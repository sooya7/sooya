import type { JobRepo } from '../../db/repos/misc.repo.js';
import type { ErrorLogRepo } from '../../db/repos/misc.repo.js';
import type { ChannelDeliveryRepo, ChannelDeliveryRow } from '../../db/repos/channel-delivery.repo.js';
import type { ChannelEventRepo } from '../../db/repos/channel-event.repo.js';
import type { ChannelIdentityRepo } from '../../db/repos/channel-identity.repo.js';
import type { MediaRepo } from '../../db/repos/media.repo.js';
import type { MessageRepo } from '../../db/repos/message.repo.js';
import type { ReplyBatchRepo } from '../../db/repos/reply-batch.repo.js';
import type { MediaStore } from '../../media/store.js';
import type { MessagePart } from '../../core/types.js';
import { QQ_CHANNEL_NAME } from './types.js';
import { QqApiClient, QqApiError } from './client.js';
import { prepareQqMedia } from './media.js';

/*
 * 出站投递（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §8-9、§11）。
 * ReplyCoordinator 不直接调 QQ API：回复完成后只入队 qq.deliver job，
 * 由这里读写 channel_delivery outbox、条件领取、调 QQ、记录/重试。
 * 文本先发，随后逐个媒体（图片/语音/贴纸/文件）；媒体失败走降级
 * （贴纸→文案、语音→文字稿、图片→跳过），不让整条回复失败。
 */
export type QqDeliveryStatus = 'sent' | 'skipped' | 'retry' | 'failed';

export const MAX_DELIVERY_ATTEMPTS = 5;

export interface QqDeliveryDeps {
  deliveries: ChannelDeliveryRepo;
  identities: ChannelIdentityRepo;
  events: ChannelEventRepo;
  messages: MessageRepo;
  replyBatches: ReplyBatchRepo;
  media: MediaRepo;
  mediaStore: MediaStore;
  jobs: JobRepo;
  errors: ErrorLogRepo;
  client: QqApiClient;
  metrics?: import('../../core/metrics.js').MetricsService;
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
    if (!owner || !owner.enabled) return 'skipped'; // 尚未绑定授权用户，等授权后再投。

    const { inserted, row } = this.deps.deliveries.enqueue({
      channel: QQ_CHANNEL_NAME,
      messageId: input.messageId,
      externalConversationId: owner.external_user_id
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
    const mediaParts = message.content.filter(
      (part) => part.type === 'image' || part.type === 'audio' || part.type === 'sticker' || part.type === 'file'
    );
    if (!text && mediaParts.length === 0) {
      this.deps.deliveries.markFailed(row.id, 'nothing_to_deliver', 'assistant message has no text or media');
      return 'failed';
    }

    const openid = owner.external_user_id;
    const msgId = this.passiveReplyMsgId(row);
    let msgSeq = 1;
    let lastRemoteMessageId = '';
    const startedAt = Date.now();
    try {
      if (text) {
        const sent = await this.deps.client.sendC2cTextMessage({ openid, content: text, msgId, msgSeq: msgId ? msgSeq : undefined });
        lastRemoteMessageId = sent.messageId;
        if (msgId) msgSeq += 1;
      }
      for (const part of mediaParts) {
        const remoteId = await this.deliverMediaPart(part, openid, msgId ? msgId : null, msgSeq);
        if (remoteId) lastRemoteMessageId = remoteId;
        if (msgId) msgSeq += 1;
      }
      this.deps.deliveries.markSent(row.id, lastRemoteMessageId);
      this.deps.metrics?.record('qq', 'outbound.sent');
      this.deps.metrics?.record('qq', 'outbound.latency', Date.now() - startedAt);
      return 'sent';
    } catch (error) {
      return this.classifyFailure(error, row, input.messageId);
    }
  }

  /** 单个媒体段投递；失败/不支持时降级，返回 null 表示未发出。 */
  private async deliverMediaPart(
    part: MessagePart,
    openid: string,
    msgId: string | null,
    msgSeq: number
  ): Promise<string | null> {
    if (!part.mediaId) return null;
    const media = this.deps.media.get(part.mediaId);
    if (!media) return null;
    const plan = await prepareQqMedia(this.deps.mediaStore, media);
    if (!plan) return this.mediaFallback(part, media, openid, msgId, msgSeq);
    try {
      const uploaded = await this.deps.client.uploadMedia({ openid, fileType: plan.fileType, bytes: plan.bytes, filename: plan.filename });
      const sent = await this.deps.client.sendC2cMediaMessage({ openid, fileUuid: uploaded.fileUuid, fileInfo: uploaded.fileInfo, msgId, msgSeq });
      this.deps.metrics?.record('qq', 'media.upload_success');
      return sent.messageId;
    } catch (error) {
      // 媒体上传/发送失败：降级为文本，不让整条回复失败（§11.3）。
      this.deps.metrics?.record('qq', 'media.upload_failed');
      this.deps.errors.add('qq.media', error instanceof Error ? error.message : String(error), {
        mediaId: part.mediaId,
        mime: media.mime,
        code: error instanceof QqApiError ? `err_${error.errCode ?? `http_${error.httpStatus}`}` : 'network'
      });
      return this.mediaFallback(part, media, openid, msgId, msgSeq);
    }
  }

  /** 降级文本：贴纸→含义文案、语音→文字稿；都没有则跳过。 */
  private async mediaFallback(
    part: MessagePart,
    media: { transcript: string | null },
    openid: string,
    msgId: string | null,
    msgSeq: number
  ): Promise<string | null> {
    const fallbackText =
      part.type === 'sticker' ? String(part.meta?.stickerMeaning ?? '') : media.transcript?.trim() ?? '';
    if (!fallbackText) return null;
    const sent = await this.deps.client.sendC2cTextMessage({ openid, content: fallbackText, msgId, msgSeq: msgId ? msgSeq : undefined });
    return sent.messageId;
  }

  private classifyFailure(error: unknown, row: ChannelDeliveryRow, messageId: string): QqDeliveryStatus {
    const apiError = error instanceof QqApiError ? error : null;
    const code =
      apiError?.errCode !== null && apiError?.errCode !== undefined
        ? `err_${apiError.errCode}`
        : apiError?.httpStatus !== null && apiError?.httpStatus !== undefined
          ? `http_${apiError.httpStatus}`
          : 'network';
    const summary = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    const retryable = apiError ? apiError.retryable : true;
    if (!retryable) {
      this.deps.deliveries.markFailed(row.id, code, summary);
      this.deps.errors.add('qq.send', summary, { messageId, code, retryable: false });
      this.deps.metrics?.record('qq', 'outbound.failed');
      return 'failed';
    }
    const attempts = row.attempts; // claim 已 +1
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      this.deps.deliveries.markFailed(row.id, code, `${summary} (attempts=${attempts})`);
      this.deps.errors.add('qq.send', summary, { messageId, code, attempts });
      this.deps.metrics?.record('qq', 'outbound.failed');
      return 'failed';
    }
    this.deps.deliveries.markRetry(row.id, code, summary, attempts + 1);
    const nextRetryAt = this.deps.deliveries.getById(row.id)!.next_retry_at!;
    // 重新入队 durable job：runAfter 让 Worker 到期再拉；DB 侧 next_retry_at 兜底。
    this.deps.jobs.enqueue('qq.deliver', { messageId, conversationId: row.external_conversation_id }, { runAfter: nextRetryAt, maxAttempts: 1 });
    this.deps.metrics?.record('qq', 'outbound.retry');
    return 'retry';
  }

  /** Admin 测试发送（§17）：发给绑定 owner，返回脱敏结果，绝不回传 token/Secret。 */
  async testSendToOwner(content: string): Promise<{
    ok: boolean;
    messageId?: string;
    errorCode?: string;
    errorSummary?: string;
  }> {
    const owner = this.deps.identities.findOwner(QQ_CHANNEL_NAME);
    if (!owner?.enabled) return { ok: false, errorCode: 'no_owner_bound', errorSummary: '还没有绑定授权用户' };
    try {
      const sent = await this.deps.client.sendC2cTextMessage({ openid: owner.external_user_id, content });
      return { ok: true, messageId: sent.messageId };
    } catch (error) {
      const apiError = error instanceof QqApiError ? error : null;
      const code =
        apiError?.errCode !== null && apiError?.errCode !== undefined
          ? `err_${apiError.errCode}`
          : apiError?.httpStatus !== null && apiError?.httpStatus !== undefined
            ? `http_${apiError.httpStatus}`
            : 'network';
      return { ok: false, errorCode: code, errorSummary: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
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