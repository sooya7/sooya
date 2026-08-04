import type { MessageRepo } from '../db/repos/message.repo.js';
import type { SummaryRepo } from '../db/repos/misc.repo.js';
import type { MemoryService, RecallMatch } from './memory.js';
import type { Persona } from '../config/schema.js';
import type { ChatMessage } from './types.js';
import type { ChatTurn, ChatContentPart } from '../providers/types.js';
import type { MediaStore } from '../media/store.js';
import type { MediaRepo } from '../db/repos/media.repo.js';
import type { LifeEngine } from './life.js';
import type { MediaTextRepo } from '../db/repos/media-text.repo.js';
import { formatZonedDateTime } from '../util/time-zone.js';
import { prepareVisionInput } from '../media/vision-input.js';

export interface BuiltContext {
  system: string;
  turns: ChatTurn[];
  usedMemories: number;
  memoryStrategy: string;
  memoryFallbackReason?: string;
  summaryCount: number;
  recentCount: number;
  visionUsed: boolean;
  lifeLines: number;
  inputBudget: number;
  estimatedInputTokens: number;
  droppedSummaries: number;
  droppedMemories: number;
  droppedRecentMessages: number;
  memoryTrace: MemoryRecallTrace;
}

export interface MemoryTraceEntry {
  id: string;
  kind: string;
  content: string;
  sources: string[];
  strategy: 'embedding' | 'fts';
  score: number | null;
  reason: string;
  included: boolean;
  droppedReason?: 'deduplicated_persona' | 'deduplicated_summary' | 'deduplicated_recent' | 'budget';
}

export interface MemoryRecallTrace {
  query: string;
  strategy: string;
  fallbackReason?: string;
  entries: MemoryTraceEntry[];
  stats: { recalled: number; included: number; deduplicated: number; budgetDropped: number };
}

export interface ContextOptions {
  recentMessages: number;
  memoryLimit: number;
  /** Include images as vision content when the model supports it. */
  allowVision: boolean;
  stickerCatalogue: string;
  /** Mood words the voice presets actually define, so the prompt cannot drift. */
  voiceMoods: string;
  capabilityNotes: string[];
  contextWindow: number;
  maxOutputTokens: number;
  /** Combine a rapid-message batch into one user turn for the model. */
  batchMessageIds?: string[];
}

export class ContextBuilder {
  private lastTrace: MemoryRecallTrace = { query: '', strategy: 'none', entries: [], stats: { recalled: 0, included: 0, deduplicated: 0, budgetDropped: 0 } };

  constructor(
    private readonly messages: MessageRepo,
    private readonly summaries: SummaryRepo,
    private readonly memory: MemoryService,
    private readonly mediaRepo: MediaRepo,
    private readonly mediaStore: MediaStore,
    private readonly mediaText: MediaTextRepo,
    private readonly life?: LifeEngine,
    private readonly timeZone = 'Asia/Shanghai'
  ) {}

  memoryRecallTrace(): MemoryRecallTrace {
    return this.lastTrace;
  }

  async build(persona: Persona, latestUserText: string, opts: ContextOptions): Promise<BuiltContext> {
    const recent = mergeContextMessages(this.messages.recent(opts.recentMessages), opts.batchMessageIds?.map((id) => this.messages.get(id)).filter((message): message is ChatMessage => Boolean(message)) ?? []);
    const activeSummaries = this.summaries.active(4);

    const recallQuery = latestUserText || recent.map(plainText).join('\n').slice(-500);
    const recall = await this.memory.recall(recallQuery, opts.memoryLimit);
    const inputBudget = Math.max(256, opts.contextWindow - opts.maxOutputTokens - 128);

    const systemParts: string[] = [];
    systemParts.push(trimToTokenEstimate(persona.systemPrompt.trim(), Math.max(96, Math.floor(inputBudget * 0.4))));
    // 这是一对一私聊。上下文里的摘要是 `用户: …` 这种转录格式，模型看了会跟着
    // 在回复开头加名牌，所以明确禁掉一次；万一还是加了，replier 会再剥一层。
    systemParts.push('你们是一对一私聊，不是群聊。直接说话，回复开头不要加「名字：」这类前缀，也不要复述对方的名字当标签。');

    const batchIds = new Set(opts.batchMessageIds ?? []);
    const convertedEntries: Array<{ message: ChatMessage; content: ChatContentPart[] }> = [];
    for (const msg of recent) {
      if (msg.role === 'system') continue;
      const content = await this.messageToParts(msg, opts.allowVision);
      if (content.length === 0) continue;
      convertedEntries.push({ message: msg, content });
    }

    const convertedTurns: ChatTurn[] = [];
    let batchInserted = false;
    for (const entry of convertedEntries) {
      if (batchIds.has(entry.message.id)) {
        if (batchInserted) continue;
        const batchContent = convertedEntries
          .filter((candidate) => batchIds.has(candidate.message.id))
          .flatMap((candidate) => candidate.content);
        if (batchContent.length > 0) convertedTurns.push({ role: 'user', content: mergeBatchContent(batchContent) });
        batchInserted = true;
        continue;
      }
      convertedTurns.push({ role: entry.message.role === 'assistant' ? 'assistant' : 'user', content: entry.content });
    }

    const turns: ChatTurn[] = [];
    for (let index = convertedTurns.length - 1; index >= 0; index--) {
      const candidate = convertedTurns[index]!;
      const next = [candidate, ...turns];
      if (estimateContextTokens(systemParts, next) <= inputBudget) turns.unshift(candidate);
      else if (index === convertedTurns.length - 1) turns.unshift(fitLatestTurn(systemParts, candidate, inputBudget));
    }
    const visionUsed = turns.some((turn) => turn.content.some((part) => part.type === 'image'));

    const deduped = dedupeSources(persona, recent, activeSummaries, recall.matches);
    const summaryLines = deduped.summaries
      .slice()
      .sort((a, b) => a.from_seq - b.from_seq)
      .map((summary) => `· ${summary.content}`);
    const summaryBudget = budgetLines(systemParts, turns, '以前聊过的重点（阶段摘要）：', summaryLines, inputBudget);
    const usedSummaries = summaryBudget.accepted.length;
    const memoryLines = deduped.matches.filter((match) => !match.droppedReason).map((match) => `· [${match.memory.kind}] ${match.memory.content}`);
    const memoryBudget = budgetLines(systemParts, turns, '关于用户你已经知道的事：', memoryLines, inputBudget);
    const usedMemories = memoryBudget.accepted.length;

    const traceEntries: MemoryTraceEntry[] = deduped.matches.map((match) => {
      const included = !match.droppedReason && memoryBudget.accepted.some((line) => line.includes(match.memory.content));
      return {
        id: match.memory.id,
        kind: match.memory.kind,
        content: match.memory.content,
        sources: match.memory.sources,
        strategy: match.strategy,
        score: match.score,
        reason: match.reason,
        included,
        ...(match.droppedReason ? { droppedReason: match.droppedReason } : included ? {} : { droppedReason: 'budget' as const })
      };
    });
    const deduplicated = traceEntries.filter((entry) => entry.droppedReason?.startsWith('deduplicated')).length;
    this.lastTrace = {
      query: recallQuery,
      strategy: recall.strategy,
      fallbackReason: recall.fallbackReason,
      entries: traceEntries,
      stats: {
        recalled: traceEntries.length,
        included: traceEntries.filter((entry) => entry.included).length,
        deduplicated,
        budgetDropped: traceEntries.filter((entry) => entry.droppedReason === 'budget').length
      }
    };

    /*
     * Her own state goes in before the capability notes: what she is doing is
     * part of who she is right now, while the capability notes are about what
     * the software can do. Keeping them separate is what stopped the world
     * engine's frozen "语音不可用" rows from being treated as personality.
     */
    const lifeLinesList = this.life?.contextLines(lastUserMessageAt(recent, opts.batchMessageIds)) ?? [];
    let lifeLines = 0;
    if (lifeLinesList.length > 0) {
      const before = systemParts.length;
      tryAddSystemPart(systemParts, turns, `你此刻的真实状态：\n${lifeLinesList.join('\n')}`, inputBudget);
      lifeLines = systemParts.length > before ? lifeLinesList.length : 0;
    }

    tryAddSystemPart(systemParts, turns, buildMultimediaInstructions(persona, opts), inputBudget);
    if (opts.capabilityNotes.length > 0) {
      tryAddSystemPart(systemParts, turns, `当前能力状态：${opts.capabilityNotes.join('；')}。不要承诺做不到的事。`, inputBudget);
    }
    const now = new Date();
    let clock = `${now.toISOString()}（UTC）`;
    try { clock = `${formatZonedDateTime(now, this.timeZone)}（${this.timeZone}）；服务器 UTC 时间：${now.toISOString()}`; } catch { /* use the explicit UTC fallback */ }
    tryAddSystemPart(systemParts, turns, `用户当地时间：${clock}。`, inputBudget);

    const estimatedInputTokens = estimateContextTokens(systemParts, turns);
    return {
      system: systemParts.filter(Boolean).join('\n\n'),
      turns,
      usedMemories,
      memoryStrategy: recall.strategy,
      memoryFallbackReason: recall.fallbackReason,
      summaryCount: usedSummaries,
      recentCount: turns.length,
      visionUsed,
      lifeLines,
      inputBudget,
      estimatedInputTokens,
      droppedSummaries: activeSummaries.length - usedSummaries,
      droppedMemories: recall.memories.length - usedMemories,
      droppedRecentMessages: convertedTurns.length - turns.length,
      memoryTrace: this.lastTrace
    };
  }

  private async messageToParts(msg: ChatMessage, allowVision: boolean): Promise<ChatContentPart[]> {
    const parts: ChatContentPart[] = [];
    const textBits: string[] = [];
    for (const p of msg.content) {
      if (p.status === 'failed') continue;
      switch (p.type) {
        case 'text':
          if (p.text) textBits.push(p.text);
          break;
        case 'sticker':
          textBits.push(`[表情包:${p.meta?.stickerName ?? p.mediaId ?? ''}]`);
          break;
        case 'audio':
          textBits.push(p.transcript ? `[语音] ${p.transcript}` : '[语音消息]');
          break;
        case 'file':
          {
            const name = p.media?.name ?? p.mediaId ?? '';
            const extracted = p.mediaId ? this.mediaText.get(p.mediaId) : undefined;
            if (extracted?.status === 'ready') textBits.push(`[文件:${name}]\n${extracted.text ?? ''}`);
            else if (extracted?.status === 'pending') textBits.push(`[文件:${name}；正文正在解析]`);
            else textBits.push(`[文件:${name}；当前无法读取正文]`);
          }
          break;
        case 'image': {
          if (allowVision && p.mediaId) {
            const row = this.mediaRepo.get(p.mediaId);
            if (row && this.mediaStore.exists(row)) {
              const read = await this.mediaStore.read(p.mediaId);
              if (read) {
                const vision = await prepareVisionInput(read.data, row.mime);
                if (vision) {
                  parts.push({ type: 'image', data: vision.data.toString('base64'), mime: vision.mime });
                  break;
                }
              }
            }
          }
          // 能力缺失与文件失败是两回事：模型不支持看图时图片根本没坏，让模型解释
          // 「图片打不开」会系统性误导对话。能力缺失用独立文案，文件真的读不了才说读取失败。
          textBits.push(allowVision ? '[图片未能读取：文件过大或格式不支持]' : '[图片：当前模型不支持看图]');
          break;
        }
        default:
          break;
      }
    }
    if (textBits.length > 0) parts.unshift({ type: 'text', text: textBits.join('\n') });
    return parts;
  }
}

export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) cjk++;
    else if (!/\s/u.test(char)) other++;
  }
  // CJK 按 1.25 token/字估算，避免低估触发上游 context_length_exceeded。
  return Math.ceil(cjk * 1.25) + Math.ceil(other / 4);
}

function estimateContextTokens(systemParts: string[], turns: ChatTurn[]): number {
  let total = estimateTextTokens(systemParts.filter(Boolean).join('\n\n')) + 4;
  for (const turn of turns) {
    total += 4;
    for (const part of turn.content) {
      total += part.type === 'text' ? estimateTextTokens(part.text) : 1024;
    }
  }
  return total;
}

function tryAddSystemPart(systemParts: string[], turns: ChatTurn[], part: string, budget: number): boolean {
  if (!part.trim()) return false;
  if (estimateContextTokens([...systemParts, part], turns) > budget) return false;
  systemParts.push(part);
  return true;
}

function budgetLines(systemParts: string[], turns: ChatTurn[], heading: string, lines: string[], budget: number): { accepted: string[]; dropped: string[] } {
  const accepted: string[] = [];
  const dropped: string[] = [];
  for (const line of lines) {
    const block = `${heading}\n${[...accepted, line].join('\n')}`;
    if (estimateContextTokens([...systemParts, block], turns) > budget) {
      dropped.push(line);
      continue;
    }
    accepted.push(line);
  }
  if (accepted.length > 0) systemParts.push(`${heading}\n${accepted.join('\n')}`);
  return { accepted, dropped };
}

function dedupeSources(
  persona: Persona,
  recent: ChatMessage[],
  summaries: ReturnType<SummaryRepo['active']>,
  matches: RecallMatch[]
): { summaries: typeof summaries; matches: Array<RecallMatch & { droppedReason?: MemoryTraceEntry['droppedReason'] }> } {
  const personaText = [persona.systemPrompt].map(normalizeFactText).filter(Boolean);
  const recentText = recent.map(plainText).map(normalizeFactText).filter(Boolean);
  const summaryKeep = summaries.slice();
  const memoryMatches: Array<RecallMatch & { droppedReason?: MemoryTraceEntry['droppedReason'] }> = matches.map((match) => ({ ...match }));
  for (const match of memoryMatches) {
    if (personaText.some((text) => similarFact(text, normalizeFactText(match.memory.content)))) {
      match.droppedReason = 'deduplicated_persona';
      continue;
    }
    if (recentText.some((text) => similarFact(text, normalizeFactText(match.memory.content)))) {
      match.droppedReason = 'deduplicated_recent';
    }
  }
  for (let i = summaryKeep.length - 1; i >= 0; i--) {
    const summary = summaryKeep[i]!;
    const summaryText = normalizeFactText(summary.content);
    if (personaText.some((text) => similarFact(text, summaryText))) {
      summaryKeep.splice(i, 1);
      continue;
    }
    const duplicate = memoryMatches.find((match) => !match.droppedReason && similarFact(summaryText, normalizeFactText(match.memory.content)));
    if (!duplicate) continue;
    if (normalizeFactText(duplicate.memory.content).length >= summaryText.length) summaryKeep.splice(i, 1);
    else duplicate.droppedReason = 'deduplicated_summary';
  }
  return { summaries: summaryKeep, matches: memoryMatches };
}

function normalizeFactText(text: string): string {
  return text.toLowerCase().replace(/^(?:用户|我|她|助手)\s*/, '').replace(/[\s\u3000.,!?;:，。！？；：、"“”'‘’()（）[\]【】]/g, '');
}

function similarFact(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || (Math.min(left.length, right.length) >= 6 && (left.includes(right) || right.includes(left)));
}

function trimToTokenEstimate(text: string, maxTokens: number): string {
  if (estimateTextTokens(text) <= maxTokens) return text;
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(chars.slice(0, mid).join('')) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join('');
}

function fitLatestTurn(systemParts: string[], turn: ChatTurn, budget: number): ChatTurn {
  const flattened = turn.content
    .map((part) => part.type === 'text' ? part.text : '[图片]')
    .filter(Boolean)
    .join('\n');
  const shell: ChatTurn = { role: turn.role, content: [{ type: 'text', text: '' }] };
  const available = Math.max(16, budget - estimateContextTokens(systemParts, [shell]));
  return {
    role: turn.role,
    content: [{ type: 'text', text: trimToTokenEstimate(flattened, available) }]
  };
}

/**
 * When the user last spoke *before now*. If the newest message is theirs -- the
 * one being replied to -- it is skipped, so the gap describes how long they had
 * been away before writing rather than always reading as "刚刚".
 */
export function lastUserMessageAt(recent: ChatMessage[], currentBatchIds?: string[]): Date | null {
  const excluded = new Set(currentBatchIds ?? []);
  const users = recent.filter((msg) => msg.role === 'user' && !excluded.has(msg.id));
  const newest = recent[recent.length - 1];
  const pool = currentBatchIds === undefined && newest?.role === 'user' ? users.slice(0, -1) : users;
  const last = pool[pool.length - 1];
  return last ? new Date(last.createdAt) : null;
}

function plainText(msg: ChatMessage): string {
  return msg.content
    .map((p) => (p.type === 'text' ? p.text ?? '' : p.type === 'audio' ? p.transcript ?? '' : ''))
    .filter(Boolean)
    .join(' ');
}

function mergeBatchContent(parts: ChatContentPart[]): ChatContentPart[] {
  const text = parts.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map((part) => part.text).filter(Boolean).join('\n');
  const media = parts.filter((part) => part.type !== 'text');
  return text ? [{ type: 'text', text }, ...media] : media;
}

function mergeContextMessages(primary: ChatMessage[], additional: ChatMessage[]): ChatMessage[] {
  const byId = new Map(primary.map((message) => [message.id, message]));
  for (const message of additional) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function buildMultimediaInstructions(persona: Persona, opts: ContextOptions): string {
  const lines: string[] = [];
  lines.push('你可以在回复里混合使用文字、表情包、图片和语音。非文字内容由你根据气氛主动决定，不要一直等用户明确要求。使用下面的标记触发，标记本身不会显示给用户：');
  lines.push('文件只有在上下文明确提供正文时才可以阅读；没有正文时不要声称看过文件内容。');
  if (persona.stickerPolicy.enabled) {
    lines.push(`· [[sticker:情绪]] 发一个表情包。可用表情：${opts.stickerCatalogue}`);
    lines.push('· [[sticker-only:情绪]] 这一条只发表情包，不发文字。');
  }
  if (persona.imagePolicy.enabled) {
    lines.push('· [[image:详细的英文或中文画面描述]] 生成并发送一张图片。');
    if (persona.referenceImages.length > 0) {
      lines.push('· [[image-self:画面描述]] 生成并发送一张你自己的照片/自拍。系统会自动附上你的形象参考图，保证长相与平时一致——生成你自己的形象时务必用这个标记，普通内容仍用 [[image:...]]。画面描述里写明拍摄视角（如正面半身、全身站姿、侧脸），系统会据此选择对应的参考图。');
    }
    lines.push('硬规则：图片/照片/自拍只有写了上述标记才会真正生成。如果你在文字里说“给你拍了”“看这张图”“拍好了”之类，却没写标记，用户只会看到文字而看不到图，等于欺骗用户。所以只要提到要发图/拍照/自拍，就必须同时写上对应标记；如果这条回复不打算真的发图，就不要在文字里声称发了图。');
  }
  if (persona.voicePolicy.enabled) {
    lines.push('· [[voice]] 把这条文字同时用语音发出来。');
    lines.push('· [[voice-only]] 这一条只发语音，不显示文字（文字会作为语音文稿保留）。');
    if (opts.voiceMoods) {
      lines.push(`· [[voice:emotion=情绪]] 或 [[voice-only:emotion=情绪]] 用指定情绪说。可用情绪：${opts.voiceMoods}`);
      lines.push('不加 emotion 时由系统根据文字自动判断，通常不用特意指定；只在语气和字面意思不一致时才写。');
    }
  }
  lines.push('主动选择建议：情绪回应、调侃、晚安、安慰和短互动适合表情包；需要温度、亲密感或语气表达时适合语音；用户在描述、想象、设计或需要直观看效果时适合图片。');
  lines.push('不要机械等待关键词，也不要为了展示能力强行添加媒体。通常一条回复主动选择一种最合适的媒体即可，除非同时使用确实更自然。');
  lines.push(
    `当前主动频率：表情包=${persona.stickerPolicy.frequency}，图片=${persona.imagePolicy.frequency}，语音=${persona.voicePolicy.frequency}。` +
      '频率含义：high=经常在合适时主动使用；medium=每隔几轮遇到自然机会就主动使用；low=只在明显合适时偶尔主动使用；never=不要主动使用。用户明确要求时仍必须照做。标记写在回复最后。'
  );
  return lines.join('\n');
}


