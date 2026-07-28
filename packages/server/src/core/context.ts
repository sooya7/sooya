import type { MessageRepo } from '../db/repos/message.repo.js';
import type { SummaryRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { MemoryService } from './memory.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { Persona } from '../config/schema.js';
import type { ChatMessage } from './types.js';
import type { ChatTurn, ChatContentPart } from '../providers/types.js';
import type { MediaStore } from '../media/store.js';
import type { MediaRepo } from '../db/repos/media.repo.js';

export interface BuiltContext {
  system: string;
  turns: ChatTurn[];
  usedMemories: number;
  memoryStrategy: string;
  memoryFallbackReason?: string;
  summaryCount: number;
  recentCount: number;
  visionUsed: boolean;
}

export interface ContextOptions {
  recentMessages: number;
  memoryLimit: number;
  /** Include images as vision content when the model supports it. */
  allowVision: boolean;
  stickerCatalogue: string;
  capabilityNotes: string[];
}

export class ContextBuilder {
  constructor(
    private readonly messages: MessageRepo,
    private readonly summaries: SummaryRepo,
    private readonly memory: MemoryService,
    private readonly mediaRepo: MediaRepo,
    private readonly mediaStore: MediaStore
  ) {}

  async build(persona: Persona, latestUserText: string, opts: ContextOptions): Promise<BuiltContext> {
    const recent = this.messages.recent(opts.recentMessages);
    // `active()` already filters on active = 1, which is exactly what
    // coveredUpTo() is derived from, so every returned row is in range.
    const activeSummaries = this.summaries.active(4);

    const recall = await this.memory.recall(latestUserText || recent.map(plainText).join('\n').slice(-500), opts.memoryLimit);

    const systemParts: string[] = [];
    systemParts.push(persona.systemPrompt.trim());
    if (persona.speakingStyle) systemParts.push(`说话风格：${persona.speakingStyle}`);
    if (persona.relationshipContext) systemParts.push(`你们的关系：${persona.relationshipContext}`);

    systemParts.push(buildMultimediaInstructions(persona, opts));

    if (activeSummaries.length > 0) {
      const text = activeSummaries
        .slice()
        .sort((a, b) => a.from_seq - b.from_seq)
        .map((s) => `· ${s.content}`)
        .join('\n');
      systemParts.push(`以前聊过的重点（阶段摘要）：\n${text}`);
    }
    if (recall.memories.length > 0) {
      const text = recall.memories.map((m) => `· [${m.kind}] ${m.content}`).join('\n');
      systemParts.push(`关于用户你已经知道的事：\n${text}`);
    }
    if (opts.capabilityNotes.length > 0) {
      systemParts.push(`当前能力状态：${opts.capabilityNotes.join('；')}。不要承诺做不到的事。`);
    }
    systemParts.push(`现在的时间是 ${new Date().toISOString()}。`);

    const turns: ChatTurn[] = [];
    let visionUsed = false;
    for (const msg of recent) {
      if (msg.role === 'system') continue;
      const content = await this.messageToParts(msg, opts.allowVision);
      if (content.length === 0) continue;
      if (content.some((c) => c.type === 'image')) visionUsed = true;
      turns.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content });
    }

    return {
      system: systemParts.filter(Boolean).join('\n\n'),
      turns,
      usedMemories: recall.memories.length,
      memoryStrategy: recall.strategy,
      memoryFallbackReason: recall.fallbackReason,
      summaryCount: activeSummaries.length,
      recentCount: recent.length,
      visionUsed
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

function plainText(msg: ChatMessage): string {
  return msg.content
    .map((p) => (p.type === 'text' ? p.text ?? '' : p.type === 'audio' ? p.transcript ?? '' : ''))
    .filter(Boolean)
    .join(' ');
}

function buildMultimediaInstructions(persona: Persona, opts: ContextOptions): string {
  const lines: string[] = [];
  lines.push('你可以在回复里混合使用文字、表情包、图片和语音。使用下面的标记来触发非文字内容，标记本身不会显示给用户：');
  if (persona.stickerPolicy.enabled) {
    lines.push(`· [[sticker:情绪]] 发一个表情包。可用表情：${opts.stickerCatalogue}`);
    lines.push('· [[sticker-only:情绪]] 这一条只发表情包，不发文字。');
  }
  if (persona.imagePolicy.enabled) lines.push('· [[image:详细的英文或中文画面描述]] 生成并发送一张图片。');
  if (persona.voicePolicy.enabled) {
    lines.push('· [[voice]] 把这条文字同时用语音发出来。');
    lines.push('· [[voice-only]] 这一条只发语音，不显示文字（文字会作为语音文稿保留）。');
  }
  lines.push(
    `使用频率：表情包=${persona.stickerPolicy.frequency}，图片=${persona.imagePolicy.frequency}，语音=${persona.voicePolicy.frequency}。` +
      '不要每条都加，只在真的合适时使用；用户明确要求时必须照做。标记要写在回复的最后。'
  );
  return lines.join('\n');
}
