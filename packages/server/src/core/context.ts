import type { MessageRepo } from '../db/repos/message.repo.js';
import type { SummaryRepo } from '../db/repos/misc.repo.js';
import type { MemoryService } from './memory.js';
import type { Persona } from '../config/schema.js';
import type { ChatMessage } from './types.js';
import type { ChatTurn, ChatContentPart } from '../providers/types.js';
import type { MediaStore } from '../media/store.js';
import type { MediaRepo } from '../db/repos/media.repo.js';
import type { LifeEngine } from './life.js';

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
}

export class ContextBuilder {
  constructor(
    private readonly messages: MessageRepo,
    private readonly summaries: SummaryRepo,
    private readonly memory: MemoryService,
    private readonly mediaRepo: MediaRepo,
    private readonly mediaStore: MediaStore,
    private readonly life?: LifeEngine
  ) {}

  async build(persona: Persona, latestUserText: string, opts: ContextOptions): Promise<BuiltContext> {
    const recent = this.messages.recent(opts.recentMessages);
    const activeSummaries = this.summaries.active(4);

    const recallQuery = latestUserText || recent.map(plainText).join('\n').slice(-500);
    const recall = await this.memory.recall(recallQuery, opts.memoryLimit);
    const inputBudget = Math.max(256, opts.contextWindow - opts.maxOutputTokens - 128);

    const systemParts: string[] = [];
    systemParts.push(trimToTokenEstimate(persona.systemPrompt.trim(), Math.max(96, Math.floor(inputBudget * 0.4))));
    // 这是一对一私聊。上下文里的摘要是 `用户: …` 这种转录格式，模型看了会跟着
    // 在回复开头加名牌，所以明确禁掉一次；万一还是加了，replier 会再剥一层。
    systemParts.push('你们是一对一私聊，不是群聊。直接说话，回复开头不要加「名字：」这类前缀，也不要复述对方的名字当标签。');
    tryAddSystemPart(systemParts, [], `说话风格：${persona.speakingStyle}`, inputBudget);
    tryAddSystemPart(systemParts, [], `你们的关系：${persona.relationshipContext}`, inputBudget);

    const convertedTurns: ChatTurn[] = [];
    for (const msg of recent) {
      if (msg.role === 'system') continue;
      const content = await this.messageToParts(msg, opts.allowVision);
      if (content.length === 0) continue;
      convertedTurns.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content });
    }

    const turns: ChatTurn[] = [];
    for (let index = convertedTurns.length - 1; index >= 0; index--) {
      const candidate = convertedTurns[index]!;
      const next = [candidate, ...turns];
      if (estimateContextTokens(systemParts, next) <= inputBudget) turns.unshift(candidate);
      else if (index === convertedTurns.length - 1) turns.unshift(fitLatestTurn(systemParts, candidate, inputBudget));
    }
    const visionUsed = turns.some((turn) => turn.content.some((part) => part.type === 'image'));

    const summaryLines = activeSummaries
      .slice()
      .sort((a, b) => a.from_seq - b.from_seq)
      .map((summary) => `· ${summary.content}`);
    const usedSummaries = addBudgetedLines(systemParts, turns, '以前聊过的重点（阶段摘要）：', summaryLines, inputBudget);
    const memoryLines = recall.memories.map((memory) => `· [${memory.kind}] ${memory.content}`);
    const usedMemories = addBudgetedLines(systemParts, turns, '关于用户你已经知道的事：', memoryLines, inputBudget);

    /*
     * Her own state goes in before the capability notes: what she is doing is
     * part of who she is right now, while the capability notes are about what
     * the software can do. Keeping them separate is what stopped the world
     * engine's frozen "语音不可用" rows from being treated as personality.
     */
    const lifeLinesList = this.life?.contextLines(lastUserMessageAt(recent)) ?? [];
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
    tryAddSystemPart(systemParts, turns, `现在的时间是 ${new Date().toISOString()}。`, inputBudget);

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
      droppedRecentMessages: convertedTurns.length - turns.length
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
          textBits.push(`[文件:${p.media?.name ?? p.mediaId ?? ''}]`);
          break;
        case 'image': {
          if (allowVision && p.mediaId) {
            const row = this.mediaRepo.get(p.mediaId);
            if (row && this.mediaStore.exists(row) && row.bytes <= 4 * 1024 * 1024) {
              const read = await this.mediaStore.read(p.mediaId);
              if (read) {
                parts.push({ type: 'image', data: read.data.toString('base64'), mime: row.mime });
                break;
              }
            }
          }
          textBits.push('[图片]');
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
  return cjk + Math.ceil(other / 4);
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

function addBudgetedLines(systemParts: string[], turns: ChatTurn[], heading: string, lines: string[], budget: number): number {
  const accepted: string[] = [];
  for (const line of lines) {
    const block = `${heading}\n${[...accepted, line].join('\n')}`;
    if (estimateContextTokens([...systemParts, block], turns) > budget) continue;
    accepted.push(line);
  }
  if (accepted.length > 0) systemParts.push(`${heading}\n${accepted.join('\n')}`);
  return accepted.length;
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
function lastUserMessageAt(recent: ChatMessage[]): Date | null {
  const users = recent.filter((msg) => msg.role === 'user');
  const newest = recent[recent.length - 1];
  const pool = newest?.role === 'user' ? users.slice(0, -1) : users;
  const last = pool[pool.length - 1];
  return last ? new Date(last.createdAt) : null;
}

function plainText(msg: ChatMessage): string {
  return msg.content
    .map((p) => (p.type === 'text' ? p.text ?? '' : p.type === 'audio' ? p.transcript ?? '' : ''))
    .filter(Boolean)
    .join(' ');
}

function buildMultimediaInstructions(persona: Persona, opts: ContextOptions): string {
  const lines: string[] = [];
  lines.push('你可以在回复里混合使用文字、表情包、图片和语音。非文字内容由你根据气氛主动决定，不要一直等用户明确要求。使用下面的标记触发，标记本身不会显示给用户：');
  if (persona.stickerPolicy.enabled) {
    lines.push(`· [[sticker:情绪]] 发一个表情包。可用表情：${opts.stickerCatalogue}`);
    lines.push('· [[sticker-only:情绪]] 这一条只发表情包，不发文字。');
  }
  if (persona.imagePolicy.enabled) lines.push('· [[image:详细的英文或中文画面描述]] 生成并发送一张图片。');
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
