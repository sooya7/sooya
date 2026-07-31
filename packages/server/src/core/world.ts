import { z } from 'zod';
import type { WorldRepo, WorldCandidate, WorldEntryRow } from '../db/repos/feature.repo.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { MessageRepo } from '../db/repos/message.repo.js';
import { extractJsonObject } from '../util/json-extract.js';

const CandidateSchema = z.object({
  kind: z.enum(['entity', 'relation', 'fact', 'scene', 'timeline']),
  subject: z.string().min(1).max(200),
  predicate: z.string().min(1).max(120),
  object: z.string().min(1).max(500),
  value: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  authority: z.enum(['model', 'user', 'admin']).optional()
});

const ExtractSchema = z.object({ entries: z.array(CandidateSchema).max(30).default([]) });

export class WorldEngine {
  constructor(
    readonly repo: WorldRepo,
    private readonly capabilities: CapabilityRegistry,
    private readonly errors: ErrorLogRepo,
    private readonly messages: MessageRepo
  ) {}

  private jsonModeNoticed = false;

  contextFor(query: string, limit = 18): string {
    const entries = this.repo.relevant(query, limit);
    if (entries.length === 0) return '';
    const lines = entries.map((entry) => {
      const authority = entry.authority === 'model' ? '' : ` [${entry.authority}]`;
      return `· (${entry.kind}) ${entry.subject} — ${entry.predicate} → ${entry.object}${authority}`;
    });
    return `当前世界状态（只使用仍启用且未冲突的条目；用户或管理员设定优先）：\n${lines.join('\n')}`;
  }

  async extract(userText: string, assistantText: string, sourceMessageId: string | null): Promise<{ stored: number; merged: number; conflicts: number }> {
    const candidates = await this.extractCandidates(userText, assistantText);
    if (candidates.length === 0) return { stored: 0, merged: 0, conflicts: 0 };
    const result = this.repo.apply(candidates, sourceMessageId);
    return { stored: result.stored, merged: result.merged, conflicts: result.conflicts };
  }

  async extractCandidates(userText: string, assistantText: string): Promise<WorldCandidate[]> {
    const combined = `${userText}\n${assistantText}`.trim();
    if (!combined) return [];
    const provider = this.capabilities.summaryProvider();
    if (!provider.configured) return heuristicCandidates(userText);
    try {
      const result = await provider.complete({
        system: [
          '你是单用户私人聊天机器人的世界状态提取器。',
          '只提取对后续剧情、角色、地点、关系、规则或时间线有长期意义的明确事实。',
          '不要把语气、临时情绪、猜测或助手自行编造的内容当事实。',
          '用户明确陈述的设定 authority=user；从对话合理确认的内容 authority=model。',
          '返回严格 JSON：{"entries":[{"kind":"entity|relation|fact|scene|timeline","subject":"...","predicate":"...","object":"...","confidence":0到1,"authority":"user|model","value":{}}]}。',
          '没有值得保存的内容时返回 {"entries":[]}。'
        ].join('\n'),
        messages: [{ role: 'user', content: [{ type: 'text', text: `用户：${userText}\n助手：${assistantText}` }] }],
        temperature: 0,
        maxTokens: 1200,
        jsonMode: true
      });
      if (result.jsonModeDegraded && !this.jsonModeNoticed) {
        this.jsonModeNoticed = true;
        this.errors.add('world.extract', 'json_mode_unsupported', { model: result.model });
      }
      const parsed = parseJson(result.text);
      const validated = ExtractSchema.safeParse(parsed);
      if (!validated.success) {
        this.errors.add('world.extract.validation', validated.error.message, { output: result.text.slice(0, 1000) });
        return heuristicCandidates(userText);
      }
      return dropVolatileSystemFacts(dedupe(validated.data.entries));
    } catch (err) {
      this.errors.add('world.extract', (err as Error).message);
      return heuristicCandidates(userText);
    }
  }

  async rebuild(limit = 400): Promise<{ cleared: number; processed: number; stored: number; conflicts: number }> {
    const rows = this.messages.recent(Math.max(2, Math.min(1000, limit))).slice().reverse();
    /*
     * Admin entries came in through the panel or an import file, not from
     * messages, so re-extraction can never bring them back -- wiping them here
     * destroyed hand-written world state for good. They are kept, and the
     * authority ranking in apply() keeps re-extracted facts from silently
     * replacing them (same subject+predicate with a different object lands as
     * a conflict instead).
     */
    const cleared = this.repo.clearExcept('admin');
    let processed = 0;
    let stored = 0;
    let conflicts = 0;
    for (let i = 0; i < rows.length; i++) {
      const current = rows[i];
      if (!current || current.role !== 'user') continue;
      const next = rows[i + 1];
      const assistant = next?.role === 'assistant' ? next : undefined;
      const result = await this.extract(textOf(current), assistant ? textOf(assistant) : '', assistant?.id ?? current.id);
      processed++;
      stored += result.stored + result.merged;
      conflicts += result.conflicts;
    }
    return { cleared, processed, stored, conflicts };
  }

  export(): { version: 1; exportedAt: string; entries: Array<ReturnType<typeof serialize>> } {
    return { version: 1, exportedAt: new Date().toISOString(), entries: this.repo.list({ limit: 500, active: undefined }).map(serialize) };
  }

  import(data: unknown): { stored: number; merged: number; conflicts: number; disabled: number } {
    const schema = z.object({ version: z.literal(1).optional(), entries: z.array(CandidateSchema.extend({ active: z.boolean().optional() })).max(2000) });
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new Error(`invalid world import: ${parsed.error.message}`);
    return this.repo.importEntries(parsed.data.entries.map((entry) => ({
      ...entry,
      authority: entry.authority ?? 'admin'
    })));
  }
}

/*
 * The extractor kept turning the assistant's own capability disclaimers into
 * permanent world facts. Production had 14 of them out of 29 rows -- "图片发送
 * 功能当前状态 → 暂时不可用", "助手语音功能 → 未调试完成" -- all written while a
 * feature was mid-debug, then injected into every later prompt as 当前世界状态.
 * One claiming image sending was unavailable was frozen at 07-29T19:14Z; an
 * image was generated at 07-30T01:40Z. The entry was lying to the model about
 * what it could do, and it is self-reinforcing: the model reads "you cannot do
 * X", says so, and the extractor records it again.
 *
 * Capability state has an authoritative live source already -- the capability
 * registry, put in the prompt as `capabilityNotes` -- so a frozen second copy
 * can only ever contradict it.
 *
 * A row is dropped only when it names a piece of the software AND talks about
 * that piece's state or availability. Both halves are required: "助手角色 / 拥有
 * / 兔子发箍" names the character and survives, while "助手 / 无法调用 / 生图工具"
 * does not. The trade-off is that a genuine roleplay limit phrased with this
 * vocabulary ("助手 / 无法 / 吃辣") is also dropped; that is worth accepting,
 * because the failure it prevents is the assistant refusing to use features it
 * actually has.
 */
const SOFTWARE_SUBJECTS = /助手|系统|客户端|界面|应用|服务端|机器人|功能|工具|模型|接口|服务|插件|权限|标识|库存|气泡|api/i;
const STATE_VOCABULARY = /不可用|可用|无法|不能|没法|未能|失败|报错|出错|异常|调试|当前状态|状态为|能力|限制|权限|配置|暂时|尚未|暂无|已不再|不再|无需|本质|性质|属性为|支持|不支持|已修复|上线|部署/;

export function isVolatileSystemFact(candidate: WorldCandidate): boolean {
  const text = `${candidate.subject} ${candidate.predicate} ${candidate.object}`;
  return SOFTWARE_SUBJECTS.test(text) && STATE_VOCABULARY.test(text);
}

function dropVolatileSystemFacts(entries: WorldCandidate[]): WorldCandidate[] {
  return entries.filter((entry) => !isVolatileSystemFact(entry));
}

function heuristicCandidates(userText: string): WorldCandidate[] {
  const out: WorldCandidate[] = [];
  const lines = userText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const setting = /^(?:设定|世界设定|记住|固定设定)[:：]\s*(.+)$/i.exec(line);
    if (setting?.[1]) {
      out.push({ kind: 'fact', subject: '世界', predicate: '设定', object: setting[1].slice(0, 500), confidence: 0.98, authority: 'user' });
      continue;
    }
    const relation = /^(.{1,40})(?:是|叫作|位于|属于|喜欢|讨厌|认识)(.{1,120})[。！!？?]?$/.exec(line);
    if (relation?.[1] && relation[2] && line.length <= 180) {
      const predicateMatch = line.match(/是|叫作|位于|属于|喜欢|讨厌|认识/);
      out.push({
        kind: predicateMatch?.[0] === '位于' ? 'relation' : 'fact',
        subject: relation[1].trim(),
        predicate: predicateMatch?.[0] ?? '是',
        object: relation[2].trim(),
        confidence: 0.82,
        authority: 'user'
      });
    }
  }
  return dedupe(out).slice(0, 12);
}

function dedupe(entries: WorldCandidate[]): WorldCandidate[] {
  const seen = new Set<string>();
  const out: WorldCandidate[] = [];
  for (const entry of entries) {
    const key = `${entry.kind}|${entry.subject.trim().toLowerCase()}|${entry.predicate.trim().toLowerCase()}|${entry.object.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function parseJson(text: string): unknown {
  const parsed = extractJsonObject(text);
  if (parsed === null) throw new Error('world extractor did not return JSON');
  return parsed;
}

function textOf(message: { content: Array<{ type: string; text?: string | null; transcript?: string | null }> }): string {
  return message.content.map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : '').filter(Boolean).join('\n');
}

function serialize(row: WorldEntryRow) {
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(row.value_json) as Record<string, unknown>; } catch { /* ignore */ }
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    value,
    confidence: row.confidence,
    authority: row.authority,
    active: row.active === 1,
    conflictOf: row.conflict_of,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
