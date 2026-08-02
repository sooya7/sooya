import type { MemoryRepo, MemoryKind } from '../db/repos/memory.repo.js';
import { cosineSimilarity, normalizeMemoryText } from '../db/repos/memory.repo.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { MemoryRecord } from './types.js';
import type { ErrorLogRepo } from '../db/repos/misc.repo.js';
import { extractJsonObject } from '../util/json-extract.js';

export interface MemoryCandidate {
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  expiresAt?: string | null;
}

export interface RecallResult {
  memories: MemoryRecord[];
  strategy: 'embedding' | 'fts' | 'none';
  matches: RecallMatch[];
  /** Populated when embeddings were expected but unavailable. */
  fallbackReason?: string;
  embeddingCoverage: { withEmbedding: number; total: number; ratio: number };
}

export interface RecallMatch {
  memory: MemoryRecord;
  strategy: 'embedding' | 'fts';
  score: number | null;
  reason: string;
}

const EXTRACTION_PROMPT = `你是记忆抽取器。判断下面这轮对话里是否有值得长期记住的信息。
只记录用户资料、稳定偏好、重要关系经历、长期项目、明确的重要事件和以后确实有用的约定。
不要记录闲聊、寒暄、临时情绪、助手的生活状态、软件能力状态、模型猜测、阶段摘要或 persona 已固定的人设。
反例：“我刚吃完饭”通常不是长期记忆；“她现在在散步”属于助手生活状态；“图片功能暂时不可用”属于软件状态。
正例：“我不吃香菜”是稳定偏好。
输出严格 JSON：{"worth":true|false,"items":[{"kind":"profile|preference|relationship|project|event","content":"一句话，中文，第三人称描述用户","importance":0~1,"confidence":0~1,"expiresInDays":可选数字}]}
kind 含义：profile=用户稳定信息(姓名/城市/职业)，preference=偏好口味习惯，relationship=你们之间的关系经历，project=项目与任务，event=近期事件(通常带 expiresInDays)。
没有值得记的就返回 {"worth":false,"items":[]}。不要输出解释。`;

/**
 * Long-term memory: extraction -> dedupe/merge -> persist -> embed -> recall.
 * Every step degrades safely; failures never break the chat.
 */
export class MemoryService {
  constructor(
    private readonly repo: MemoryRepo,
    private readonly capabilities: CapabilityRegistry,
    private readonly errorLog: ErrorLogRepo,
    private readonly opts: { disabled?: boolean } = {}
  ) {}

  private jsonModeNoticed = false;

  get disabled(): boolean {
    return this.opts.disabled === true;
  }

  /** Cheap pre-filter so we don't call the model for "嗯"/"哈哈". */
  worthConsidering(text: string): boolean {
    const t = text.trim();
    if (t.length < 4) return false;
    const semantic = t.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{P}\p{S}\s]/gu, '');
    if (semantic.length < 2) return false;
    if (/^(嗯+|哦+|好的?|哈+|ok|okay|谢谢|在吗|你好|hi|hello|晚安|早安)[。.!！~\s]*$/i.test(t)) return false;
    return true;
  }

  async extractCandidates(userText: string, assistantText: string, signal?: AbortSignal): Promise<MemoryCandidate[]> {
    if (this.disabled) return [];
    if (!this.worthConsidering(userText)) return [];
    const provider = this.capabilities.summaryProvider();
    if (!provider.configured) return this.heuristicCandidates(userText);
    try {
      const result = await provider.complete({
        system: EXTRACTION_PROMPT,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: `用户说：${userText}\n\n你回复：${assistantText || '(无)'}` }]
          }
        ],
        maxTokens: 500,
        temperature: 0,
        jsonMode: true,
        signal
      });
      // Say it once: "the endpoint has no JSON mode" is a setup fact, and the
      // silent version of it used to look like "nothing worth remembering".
      if (result.jsonModeDegraded && !this.jsonModeNoticed) {
        this.jsonModeNoticed = true;
        this.errorLog.add('memory.extract', 'json_mode_unsupported', { model: result.model });
      }
      return parseCandidates(result.text).filter(isAllowedCandidate);
    } catch (err) {
      this.errorLog.add('memory.extract', (err as Error).message);
      return this.heuristicCandidates(userText);
    }
  }

  /** Offline fallback: a few high-precision patterns only. */
  heuristicCandidates(userText: string): MemoryCandidate[] {
    const out: MemoryCandidate[] = [];
    const t = userText.trim();
    const push = (kind: MemoryKind, content: string, importance = 0.6, confidence = 0.55) =>
      out.push({ kind, content, importance, confidence });

    const name = /(?:我叫|我的名字是|你可以叫我|我是)\s*([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_·\- ]{0,18})/.exec(t);
    if (name?.[1]) push('profile', `用户的名字/称呼是「${name[1].trim()}」`, 0.9, 0.75);

    const live = /(?:我住在|我在)\s*([\u4e00-\u9fa5]{2,12}?)(?:市|区|县)?(?:住|工作|生活|上班)/.exec(t);
    if (live?.[1]) push('profile', `用户所在城市/地点：${live[1]}`, 0.8, 0.65);

    const job = /(?:我是(?:一名|一个)?|我的职业是|我做)\s*([\u4e00-\u9fa5A-Za-z]{2,14}?)(?:的)?(?:工作|工程师|开发|设计师|老师|学生|医生|律师)/.exec(t);
    if (job) push('profile', `用户的职业相关信息：${job[0].replace(/^我是(一名|一个)?/, '')}`, 0.7, 0.6);

    const like = /(?:我(?:很)?喜欢|我爱|我最喜欢)\s*([^，。,.!！?？\n]{2,30})/.exec(t);
    if (like?.[1]) push('preference', `用户喜欢${like[1].trim()}`, 0.6, 0.6);

    const dislike = /(?:我(?:很)?讨厌|我不喜欢|我受不了)\s*([^，。,.!！?？\n]{2,30})/.exec(t);
    if (dislike?.[1]) push('preference', `用户不喜欢${dislike[1].trim()}`, 0.6, 0.6);

    const project = /(?:我(?:在|正在)(?:做|开发|写|搞)|我的项目(?:是|叫))\s*([^，。,.!！?？\n]{2,40})/.exec(t);
    if (project?.[1]) push('project', `用户正在进行的项目：${project[1].trim()}`, 0.7, 0.6);

    return out;
  }

  /**
   * Store candidates with dedupe + semantic merge.
   * Similar memories (normalized equality or high cosine similarity) are merged
   * instead of duplicated.
   */
  async remember(candidates: MemoryCandidate[], sourceMessageId: string): Promise<{ stored: number; merged: number; superseded: number }> {
    if (this.disabled || candidates.length === 0) return { stored: 0, merged: 0, superseded: 0 };
    let stored = 0;
    let merged = 0;
    let superseded = 0;
    for (const c of candidates) {
      const content = c.content.trim();
      if (content.length < 3 || content.length > 500 || !isAllowedCandidate({ ...c, content })) continue;
      const expiresAt = memoryExpiry(c.kind, c.expiresAt);
      const identity = factIdentity(c.kind, content);
      const conflict = identity
        ? this.repo.list({ limit: 500 }).find((memory) =>
            memory.kind === c.kind && factIdentity(c.kind, memory.content) === identity && normalizeMemoryText(memory.content) !== normalizeMemoryText(content))
        : undefined;
      if (conflict) {
        const result = this.repo.supersede(conflict.id, {
          kind: c.kind,
          content,
          importance: clamp01(c.importance),
          confidence: clamp01(c.confidence),
          expiresAt,
          sourceMessageId
        });
        stored++;
        superseded++;
        await this.embedOne(result.replacement.id, result.replacement.content);
        continue;
      }
      const semantic = await this.findSemanticDuplicate(content);
      if (semantic && semantic.kind !== 'summary') {
        this.repo.upsert({
          kind: semantic.kind,
          content: semantic.content,
          importance: Math.max(semantic.importance, c.importance),
          confidence: Math.max(semantic.confidence, c.confidence),
          sourceMessageId
        });
        merged++;
        continue;
      }
      const { record, merged: wasMerged } = this.repo.upsert({
        kind: c.kind,
        content,
        importance: clamp01(c.importance),
        confidence: clamp01(c.confidence),
        expiresAt,
        sourceMessageId
      });
      if (wasMerged) merged++;
      else stored++;
      await this.embedOne(record.id, record.content);
    }
    return { stored, merged, superseded };
  }

  private async findSemanticDuplicate(content: string): Promise<MemoryRecord | null> {
    const normalized = normalizeMemoryText(content);
    // Exact-normalized duplicates are handled by the repo's unique index.
    const embedder = this.capabilities.embeddingProvider();
    if (!embedder.configured) {
      // Cheap lexical containment check as a fallback.
      const candidates = this.repo.searchFts(content, 5);
      for (const m of candidates) {
        const n = normalizeMemoryText(m.content);
        if (n === normalized) return m;
        if (n.length > 8 && (n.includes(normalized) || normalized.includes(n))) return m;
      }
      return null;
    }
    try {
      const { vectors, dimensions } = await embedder.embed([content]);
      const vec = vectors[0];
      if (!vec) return null;
      const existing = this.repo.activeWithEmbeddings(dimensions);
      let best: { record: MemoryRecord; score: number } | null = null;
      for (const e of existing) {
        const score = cosineSimilarity(vec, e.vector);
        if (!best || score > best.score) best = { record: this.repo.toRecord(e.row), score };
      }
      if (best && best.score >= 0.92) return best.record;
      return null;
    } catch (err) {
      this.errorLog.add('memory.dedupe', (err as Error).message);
      return null;
    }
  }

  async embedOne(memoryId: string, content: string): Promise<boolean> {
    const embedder = this.capabilities.embeddingProvider();
    if (!embedder.configured) return false;
    try {
      const { vectors, model, dimensions } = await embedder.embed([content]);
      const vec = vectors[0];
      if (!vec || vec.length !== dimensions) return false;
      this.repo.setEmbedding(memoryId, vec, model);
      return true;
    } catch (err) {
      this.errorLog.add('memory.embed', (err as Error).message);
      return false;
    }
  }

  /** Backfill embeddings for memories stored while the embedder was down. */
  async backfillEmbeddings(limit = 20): Promise<number> {
    const embedder = this.capabilities.embeddingProvider();
    if (!embedder.configured) return 0;
    const pending = this.repo.list({ limit: 500 }).filter((m) => !m.hasEmbedding).slice(0, limit);
    let done = 0;
    for (const m of pending) {
      if (await this.embedOne(m.id, m.content)) done++;
    }
    return done;
  }

  /**
   * Recall relevant memories. Uses embeddings when available and falls back to
   * FTS, always reporting which strategy was used and why.
   */
  async recall(query: string, limit = 8): Promise<RecallResult> {
    const total = this.repo.count(true);
    const withEmbedding = this.repo.countWithEmbeddings();
    const coverage = { withEmbedding, total, ratio: total === 0 ? 0 : withEmbedding / total };
    if (this.disabled || total === 0) {
      return { memories: [], matches: [], strategy: 'none', embeddingCoverage: coverage, fallbackReason: total === 0 ? 'no memories stored' : 'memory disabled' };
    }
    const embedder = this.capabilities.embeddingProvider();
    if (embedder.configured) {
      try {
        const { vectors, dimensions } = await embedder.embed([query]);
        const vec = vectors[0];
        const dim = this.capabilities.embeddingDimensions() ?? dimensions;
        if (vec && vec.length === dim) {
          const pool = this.repo.activeWithEmbeddings(dim);
          if (pool.length > 0) {
            const scored = pool
              .map((p) => ({ record: this.repo.toRecord(p.row), score: cosineSimilarity(vec, p.vector) }))
              .filter((s) => s.score >= 0.2)
              .sort((a, b) => b.score - a.score || b.record.importance - a.record.importance)
              .slice(0, limit);
            this.repo.bumpHits(scored.map((s) => s.record.id));
            return {
              memories: scored.map((s) => s.record),
              matches: scored.map((s) => ({ memory: s.record, strategy: 'embedding', score: s.score, reason: `embedding cosine ${s.score.toFixed(3)}` })),
              strategy: 'embedding', embeddingCoverage: coverage
            };
          }
          const fts = this.repo.searchFts(query, limit);
          this.repo.bumpHits(fts.map((m) => m.id));
          return {
            memories: fts, matches: ftsMatches(fts),
            strategy: 'fts',
            fallbackReason: 'no memories carry embeddings of the current dimension',
            embeddingCoverage: coverage
          };
        }
        const fts = this.repo.searchFts(query, limit);
        return {
          memories: fts, matches: ftsMatches(fts),
          strategy: 'fts',
          fallbackReason: `embedding dimension mismatch (expected ${dim}, got ${vec?.length ?? 0})`,
          embeddingCoverage: coverage
        };
      } catch (err) {
        this.errorLog.add('memory.recall', (err as Error).message);
        const fts = this.repo.searchFts(query, limit);
        this.repo.bumpHits(fts.map((m) => m.id));
        return {
          memories: fts, matches: ftsMatches(fts),
          strategy: 'fts',
          fallbackReason: `embedding provider failed: ${(err as Error).message}`,
          embeddingCoverage: coverage
        };
      }
    }
    const fts = this.repo.searchFts(query, limit);
    this.repo.bumpHits(fts.map((m) => m.id));
    return { memories: fts, matches: ftsMatches(fts), strategy: 'fts', fallbackReason: 'embedding provider not configured', embeddingCoverage: coverage };
  }

  /** Drop memories whose expiry has passed. Returns the number removed. */
  purgeExpired(): number {
    return this.repo.purgeExpired();
  }

  clearAll(): { memories: number; summaries: number } {
    return this.repo.clearAll();
  }

  stats(): { total: number; withEmbedding: number; coverage: number; byKind: Record<string, number> } {
    const total = this.repo.count(true);
    const withEmbedding = this.repo.countWithEmbeddings();
    const byKind: Record<string, number> = {};
    for (const m of this.repo.list({ limit: 500 })) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    return { total, withEmbedding, coverage: total === 0 ? 0 : withEmbedding / total, byKind };
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

export function parseCandidates(raw: string): MemoryCandidate[] {
  const parsed = extractJsonObject(raw);
  if (parsed === null) return [];
  const obj = parsed as { worth?: boolean; items?: unknown };
  if (obj.worth === false) return [];
  if (!Array.isArray(obj.items)) return [];
  const valid: MemoryKind[] = ['profile', 'preference', 'relationship', 'project', 'event'];
  const out: MemoryCandidate[] = [];
  for (const item of obj.items) {
    const it = item as { kind?: string; content?: string; importance?: number; confidence?: number; expiresInDays?: number };
    if (typeof it.content !== 'string' || it.content.trim().length < 3) continue;
    if (!(valid as string[]).includes(it.kind ?? '')) continue;
    const kind = it.kind as MemoryKind;
    const candidate: MemoryCandidate = {
      kind,
      content: it.content.trim(),
      importance: clamp01(typeof it.importance === 'number' ? it.importance : 0.5),
      confidence: clamp01(typeof it.confidence === 'number' ? it.confidence : 0.6),
      expiresAt:
        kind === 'event'
          ? new Date(Date.now() + Math.max(30, Math.min(90, typeof it.expiresInDays === 'number' ? it.expiresInDays : 60)) * 86400_000).toISOString()
          : null
    };
    if (isAllowedCandidate(candidate)) out.push(candidate);
  }
  return out.slice(0, 8);
}

function memoryExpiry(kind: MemoryKind, expiresAt?: string | null): string | null {
  if (expiresAt) return expiresAt;
  return kind === 'event' ? new Date(Date.now() + 60 * 86_400_000).toISOString() : null;
}

function isAllowedCandidate(candidate: Pick<MemoryCandidate, 'kind' | 'content'>): boolean {
  const text = candidate.content.trim();
  if (/^(?:助手|她|机器人|SOOYA|苏娅)(?:现在|今天|刚才|正在|的心情|的性格)/i.test(text)) return false;
  if (/(?:图片|语音|模型|系统|软件|功能|服务|接口).{0,12}(?:暂时|目前|现在)?(?:不可用|可用|故障|失败|配置|支持|不支持)/i.test(text)) return false;
  if (/(?:用户|我)?(?:刚|刚才|现在|正在|今天)?(?:吃完(?:饭)?|吃了(?:饭)?|在吃饭|散步|洗澡|午睡|睡醒|起床)(?:了|中)?$/i.test(text)) return false;
  if (/^(?:嗯+|哦+|好(?:的)?|哈+|谢谢|你好|晚安|早安)[。.!！~\s]*$/i.test(text)) return false;
  return true;
}

function factIdentity(kind: MemoryKind, content: string): string | null {
  const normalized = normalizeMemoryText(content).replace(/^用户(?:的)?/, '');
  if (kind === 'profile') {
    if (/(?:名字|姓名|称呼|叫)/.test(normalized)) return 'profile:name';
    if (/(?:住在|所在|城市|地点|居住)/.test(normalized)) return 'profile:location';
    if (/(?:职业|工作|工程师|设计师|老师|学生|医生|律师)/.test(normalized)) return 'profile:occupation';
    return null;
  }
  if (kind !== 'preference') return null;
  const subject = normalized
    .replace(/^(?:已经)?(?:很|最)?(?:不再|不喜欢|喜欢|爱|讨厌|受不了|不吃|不喝|戒了)/, '')
    .replace(/^(?:再也)?不再/, '')
    .trim();
  return subject.length >= 2 ? `preference:${subject}` : null;
}

function ftsMatches(memories: MemoryRecord[]): RecallMatch[] {
  return memories.map((memory) => ({ memory, strategy: 'fts', score: null, reason: 'FTS lexical match' }));
}
