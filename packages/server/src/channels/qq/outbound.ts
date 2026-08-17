import type { JobRepo } from '../../db/repos/misc.repo.js';
import type { ErrorLogRepo } from '../../db/repos/misc.repo.js';
import type { ChannelDeliveryRepo, ChannelDeliveryRow } from '../../db/repos/channel-delivery.repo.js';
import type { ChannelEventRepo } from '../../db/repos/channel-event.repo.js';
import type { ChannelIdentityRepo } from '../../db/repos/channel-identity.repo.js';
import type { MessageRepo } from '../../db/repos/message.repo.js';
import type { ReplyBatchRepo } from '../../db/repos/reply-batch.repo.js';
import { QQ_CHANNEL_NAME } from './types.js';
import { QqApiClient, QqApiError } from './client.js';

/*
 * 出站投递（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §8-9）。
 * ReplyCoordinator 不直接调 QQ API：回复完成后只入队 qq.deliver job，
 * 由这里读写 channel_delivery outbox、条件领取、调 QQ、记录/重试。
 * Life 主动消息在 PR5 走同一路径。
 */
export type QqDeliveryStatus = 'sent' | 'skipped' | 'retry' | 'failed';

export const MAX_DELIVERY_ATTEMPTS = 5;

export interface QqDeliveryDeps {
  deliveries: ChannelDeliveryRepo;
  identities: ChannelIdentityRepo;
  events: ChannelEventRepo;
  messages: MessageRepo;
  replyBatches: ReplyBatchRepo;
  jobs: JobRepo;
  errors: ErrorLogRepo;
  client: QqApiClient;
}

export class QqDeliveryService {
  constructor(private readonly deps: QqDeliveryDeps) {}

  /**
   * 投递一条 assistant 消息。幂等：
   * - (channel, message_id, external_conversation_id) 唯一 → 同一条消息只入队一次
   * - 条件领取（pending/retry→sending）→ 并发执行者只有一个
   * - 已 sent → 直接跳过；重复 job / 重启恢复都不会重复发送
   */
  async deliver(input: { messageId: string; conversationId?: string }): Promise<QqDeliveryStatus> {
    const owner = this.deps.identities.findOwner(QQ_CHANNEL_NAME);
    if (!owner || !owner.enabled) return 'skipped'; // 尚未绑定授权用户，等 PR5/授权后再投。
    const externalConversationId = owner.external_user_id;

    const { inserted, row } = this.deps.deliveries.enqueue({
      channel: QQ_CHANNEL_NAME,
      messageId: input.messageId,
      externalConversationId
    });
    if (row.status === 'sent') return 'skipped';
    if (!inserted && row.status === 'failed') return 'failed'; // 历史失败不再自动复活
    if (!this.deps.deliveries.claim(row.id)) return 'skipped'; // 已被另一个执行者领取

    const message = this.deps.messages.get(input.messageId);
    if (!message) {
      this.deps.deliveries.markFailed(row.id, 'message_missing', 'assistant message not found');
      return 'failed';
    }
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n');
    if (!text) {
      // 纯媒体回复（图片/语音/贴纸）由 PR4 处理；先标记失败让 Admin 可见，不静默吞掉。
      this.deps.deliveries.markFailed(row.id, 'media_only_not_supported', 'assistant message has no text to deliver');
      return 'failed';
    }

    const msgId = this.passiveReplyMsgId(row);
    try {
      const sent = await this.deps.client.sendC2cTextMessage({
        openid: externalConversationId,
        content: text,
        msgId
      });
      this.deps.deliveries.markSent(row.id, sent.messageId);
      return 'sent';
    } catch (error) {
      const apiError = error instanceof QqApiError ? error : null;
      const code = apiError?.errCode !== null && apiError?.errCode !== undefined
        ? `err_${apiError.errCode}`
        : apiError?.httpStatus !== null && apiError?.httpStatus !== undefined
          ? `http_${apiError.httpStatus}`
          : 'network';
      const summary = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      const retryable = apiError ? apiError.retryable : true;
      if (!retryable) {
        this.deps.deliveries.markFailed(row.id, code, summary);
        this.deps.errors.add('qq.send', summary, { messageId: input.messageId, code, retryable: false });
        return 'failed';
      }
      const attempts = row.attempts; // claim 已 +1
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.deps.deliveries.markFailed(row.id, code, `${summary} (attempts=${attempts})`);
        this.deps.errors.add('qq.send', summary, { messageId: input.messageId, code, attempts });
        return 'failed';
      }
      this.deps.deliveries.markRetry(row.id, code, summary, attempts + 1);
      const nextRetryAt = this.deps.deliveries.getById(row.id)!.next_retry_at!;
      // 重新入队 durable job：runAfter 让 Worker 到期再拉；DB 侧 next_retry_at 兜底。
      this.deps.jobs.enqueue('qq.deliver', { messageId: input.messageId, conversationId: input.conversationId ?? null }, { runAfter: nextRetryAt, maxAttempts: 1 });
      return 'retry';
    }
  }

  /** Server 重启 / 长时间停摆恢复：把卡在 sending 的投递放回 pending，由下次扫描重投。 */
  recoverInFlight(): void {
    this.deps.deliveries.recoverInFlight();
  }

  private passiveReplyMsgId(row: ChannelDeliveryRow): string | null {
    // 回复类消息：找产出这条 assistant 消息的 batch 的触发用户消息，
    // 再经 channel_event 反查该用户消息的 QQ 平台消息 id，作为被动回复 msg_id。
    const batch = this.deps.replyBatches.findByMessage(row.message_id);
    const triggerId = batch?.trigger_message_id;
    if (!triggerId) return null;
    if (triggerId === row.message_id) return null; // 主动 message（无用户触发）
    const event = this.deps.events.findByMessageId(triggerId);
    return event?.remote_message_id ?? null;
  }
}