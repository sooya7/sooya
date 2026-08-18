import type { DbHandle } from '../db/handle.js';
import type { ConfigStore } from '../config/store.js';
import type { MessageRepo } from '../db/repos/message.repo.js';
import type { AppendOrCreateResult, ReplyBatchRepo } from '../db/repos/reply-batch.repo.js';
import type { MediaRepo } from '../db/repos/media.repo.js';
import type { StickerRepo } from '../db/repos/sticker.repo.js';
import type { ErrorLogRepo, JobRepo } from '../db/repos/misc.repo.js';
import type { EventBus } from '../events/bus.js';
import type { MediaStore } from '../media/store.js';
import type { ReplyCoordinator } from './reply-coordinator.js';
import type { ReplyOutcome, ReplyOptions } from './replier.js';
import type { ChatMessage, InputPart } from './types.js';
import { parseUserDirectives } from './directives.js';

/*
 * 唯一的用户消息入口。
 *
 * QQ inbound 只负责协议转换；消息落库、去重、message.received 事件、
 * reply batch 准入与协调器唤醒全部收敛在这里。
 */

export type MessageIngressSource = 'qq';

/** 与 InputPart 对齐的入站内容段；QQ 媒体段在接入时再扩展。 */
export type MessageIngressContentPart = InputPart;

export interface MessageIngressInput {
  clientMessageId: string;
  source: MessageIngressSource;
  /** SOOYA 内部会话；当前恒为 'main'，QQ → 会话映射落库前仅透传。 */
  conversationId: string;
  /** 通道内的发送者标识；单用户环境暂不落库，仅作审计/映射预留。 */
  senderId: string;
  replyTo?: string | null;
  content: MessageIngressContentPart[];
  /** 通道特定元信息。 */
  metadata?: Record<string, unknown>;
}

export interface MessageIngressResult {
  messageId: string;
  duplicate: boolean;
  /** 仅重复且回复仍在途时返回。 */
  batchId?: string;
  replyPending: boolean;
}

export interface MessageIngressSyncResult extends MessageIngressResult {
  reply: ChatMessage | null;
  outcome: ReplyOutcome | null;
}

/** 输入校验失败（媒体不存在 / 引用目标不存在）。Route 捕获后按 400 回显 details。 */
export class MessageIngressValidationError extends Error {
  constructor(readonly details: Record<string, unknown>) {
    super('message ingress validation failed');
    this.name = 'MessageIngressValidationError';
  }
}

export interface MessageIngressDeps {
  db: DbHandle;
  messages: MessageRepo;
  replyBatches: ReplyBatchRepo;
  media: MediaRepo;
  stickers: StickerRepo;
  jobs: JobRepo;
  errors: ErrorLogRepo;
  bus: EventBus;
  config: ConfigStore;
  mediaStore: MediaStore;
  replyCoordinator: ReplyCoordinator;
  replyOptions: ReplyOptions;
}

type StoredPart = {
  type: InputPart['type']; text?: string | null; mediaId?: string | null; status: 'sent'; duration: null; transcript: null; meta?: Record<string, unknown>
};

export class MessageIngressService {
  constructor(private readonly deps: MessageIngressDeps) {}

  /** 落库并异步唤醒回复协调器；不等待回复。 */
  async accept(input: MessageIngressInput): Promise<MessageIngressResult> {
    const { message, created, admission } = this.core(input);
    if (!created) return this.duplicateResult(message);
    if (admission) {
      // Never block the HTTP response on coordination; errors are logged.
      void this.deps.replyCoordinator
        .onMessageAccepted(admission.action, admission.batch.id, this.deps.replyOptions)
        .catch((error) => {
          this.deps.errors.add('reply-coordinator', error instanceof Error ? error.message : String(error));
        });
    }
    return { messageId: message.id, duplicate: false, replyPending: true };
  }

  /** 落库并等待回复完成；重复消息直接返回已有关联回复，不重复触发模型调用。 */
  async acceptAndReply(input: MessageIngressInput): Promise<MessageIngressSyncResult> {
    const { message, created, admission } = this.core(input);
    if (!created) {
      return { ...this.duplicateResult(message), reply: this.findReply(message.id), outcome: null };
    }
    const outcome = admission
      ? await this.deps.replyCoordinator.enqueue(admission.batch.id, this.deps.replyOptions)
      : null;
    return {
      messageId: message.id,
      duplicate: false,
      replyPending: true,
      batchId: admission?.batch.id,
      reply: outcome?.messageId ? (this.deps.messages.get(outcome.messageId) ?? null) : null,
      outcome
    };
  }

  /**
   * 校验 → directives 解析 → 单事务落库（消息 + sticker job + message.received
   * + reply batch 准入）→ 事件广播。两个 accept 变体共享，重复时事务内不写任何东西。
   */
  private core(input: MessageIngressInput): {
    message: ChatMessage;
    created: boolean;
    admission: AppendOrCreateResult | null;
  } {
    const validation = this.validateInput(input);
    if (validation) throw new MessageIngressValidationError(validation);
    const text = input.content
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('\n');
    const explicit = (input.metadata?.directives ?? {}) as Record<string, unknown>;
    const directives = { ...parseUserDirectives(text), ...explicit };
    const tx = this.deps.db.transaction(() => {
      const parts = this.storedInputParts(input.content);
      const created = this.deps.messages.createInTransaction({
        role: 'user',
        status: 'sent',
        clientMsgId: input.clientMessageId,
        replyTo: input.replyTo ?? null,
        parts,
        meta: { directives }
      });
      if (created.created) this.enqueueStickerMeaningJobs(parts);
      const event = created.created ? this.deps.bus.persist('message.received', { message: created.message }) : null;
      const admission = created.created
        ? this.deps.replyBatches.appendOrCreateMessage(
            created.message.id,
            this.deps.replyCoordinator.dueAt(Date.now(), false),
            this.deps.replyCoordinator.dueAt(Date.now(), true)
          )
        : null;
      return { ...created, event, admission };
    });
    const { message, created, event, admission } = tx();
    if (created) this.deps.bus.fanout(event!);
    return { message, created, admission };
  }

  private duplicateResult(message: ChatMessage): MessageIngressResult {
    const batch = this.deps.replyBatches.findByMessage(message.id);
    const pending =
      batch !== undefined
      && (batch.status === 'collecting' || batch.status === 'queued'
        || batch.status === 'generating' || batch.status === 'publishing');
    return { messageId: message.id, duplicate: true, replyPending: pending, ...(pending ? { batchId: batch.id } : {}) };
  }

  private validateInput(input: MessageIngressInput): Record<string, unknown> | null {
    for (const part of input.content) {
      if (part.type === 'text') continue;
      const media = this.deps.media.get(part.mediaId);
      if (!media) return part.type === 'sticker' ? { error: 'unknown_sticker', mediaId: part.mediaId } : { error: 'unknown_media', mediaId: part.mediaId };
      if (part.type === 'sticker') {
        const sticker = this.deps.stickers.getByMediaId(part.mediaId);
        if (media.kind !== 'sticker' || !sticker || !sticker.enabled || !this.deps.mediaStore.exists(media)) return { error: 'unknown_sticker', mediaId: part.mediaId };
      }
    }
    if (input.replyTo && !this.deps.messages.get(input.replyTo)) return { error: 'unknown_reply_target', replyTo: input.replyTo };
    return null;
  }

  private storedInputParts(content: MessageIngressContentPart[]): StoredPart[] {
    return content.map((part) => {
      if (part.type !== 'sticker') return { type: part.type, text: part.type === 'text' ? part.text : null, mediaId: 'mediaId' in part ? part.mediaId : null, status: 'sent', duration: null, transcript: null };
      const sticker = this.deps.stickers.getByMediaId(part.mediaId)!;
      return {
        type: 'sticker', text: null, mediaId: part.mediaId, status: 'sent', duration: null, transcript: null,
        meta: { stickerId: sticker.id, stickerName: sticker.name, stickerMeaning: (sticker.description || sticker.emotion).slice(0, 120) }
      };
    });
  }

  private enqueueStickerMeaningJobs(parts: StoredPart[]): void {
    if (!this.deps.config.getPersona().stickerPolicy.learnUserMeaning) return;
    for (const part of parts) {
      if (part.type !== 'sticker') continue;
      const id = String(part.meta?.stickerId ?? '');
      const sticker = this.deps.stickers.markUserUsed(id);
      if (sticker && sticker.userUseCount >= 3 && sticker.userUseCount % 3 === 0) {
        this.deps.jobs.enqueue('sticker.user-meaning.learn', { stickerId: id }, { maxAttempts: 2 });
      }
    }
  }

  private findReply(userMessageId: string): ChatMessage | null {
    const batch = this.deps.replyBatches.findByMessage(userMessageId);
    if (batch?.assistant_message_id) return this.deps.messages.get(batch.assistant_message_id) ?? null;
    for (const message of this.deps.messages.recent(20).reverse()) {
      const batchMessageIds = message.meta?.batchMessageIds;
      if (message.role === 'assistant'
        && (message.replyTo === userMessageId || (Array.isArray(batchMessageIds) && batchMessageIds.includes(userMessageId)))) {
        return message;
      }
    }
    return null;
  }
}
