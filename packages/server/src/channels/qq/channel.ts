import type { ErrorLogRepo, JobRepo } from '../../db/repos/misc.repo.js';
import type { ChannelEventRepo, ChannelEventStatus } from '../../db/repos/channel-event.repo.js';
import type { ChannelIdentityRepo } from '../../db/repos/channel-identity.repo.js';
import type { MessageIngressService } from '../../core/message-ingress.js';
import type { MediaStore } from '../../media/store.js';
import type { InputPart } from '../../core/types.js';
import type { QqBotConfig } from './config.js';
import {
  QQ_CHANNEL_NAME,
  QQ_OP_ACK,
  QQ_OP_DISPATCH,
  QQ_OP_VALIDATION,
  type QqC2cMessageData,
  type QqPayload,
  type QqValidationData
} from './types.js';
import { signValidationResponse, verifyEventSignature } from './verify.js';
import { resolveQqIdentity } from './mapping.js';
import { c2cMessageToIngress, resolveQuoteReplyTo } from './inbound.js';
import { downloadQqImageAttachment } from './inbound-media.js';
import type { FlowTraceService } from '../../core/flow-trace.js';

/*
 * QQ 通道编排层：把 verify / mapping / inbound / MessageIngress 串起来，
 * route 只做 HTTP 协议转换。事件处理流程（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §6）：
 *
 *   收到 QQ Event → 校验签名 → 尝试写 channel_event
 *   → 已存在：直接 ACK
 *   → 新事件：身份映射 → 转 MessageIngressInput → MessageIngressService → 标记 processed
 */

export interface QqChannelDeps {
  config: QqBotConfig;
  events: ChannelEventRepo;
  identities: ChannelIdentityRepo;
  ingress: MessageIngressService;
  jobs: JobRepo;
  mediaStore: MediaStore;
  fetchImpl: typeof fetch;
  maxAttachmentBytes: number;
  errors: ErrorLogRepo;
  metrics?: import('../../core/metrics.js').MetricsService;
  flowTrace?: FlowTraceService;
}

export interface QqDispatchOutcome {
  ack: { op: typeof QQ_OP_ACK };
  eventStatus: ChannelEventStatus;
}

export class QqChannel {
  constructor(private readonly deps: QqChannelDeps) {}

  get config(): QqBotConfig {
    return this.deps.config;
  }

  /** op 13 URL 验证：回传 { plain_token, signature }。入参非法返回 null。 */
  handleValidation(data: QqValidationData | undefined): { plain_token: string; signature: string } | null {
    const plainToken = typeof data?.plain_token === 'string' ? data.plain_token.trim() : '';
    const eventTs = typeof data?.event_ts === 'string' ? data.event_ts.trim() : '';
    if (!plainToken || !eventTs) return null;
    return {
      plain_token: plainToken,
      signature: signValidationResponse(this.deps.config.callbackSecret, eventTs, plainToken)
    };
  }

  /**
   * 校验事件推送签名（timestamp + body Ed25519）。rawBody 缺失视为校验失败。
   */
  verifyEvent(timestamp: unknown, signature: unknown, rawBody: Buffer | undefined): boolean {
    if (!rawBody) return false;
    return verifyEventSignature(this.deps.config.callbackSecret, timestamp, signature, rawBody);
  }

  /**
   * Dispatch 事件处理：幂等 → 身份映射 → inbound → MessageIngress。
   * 事件被重用平台重推时直接 ACK，不重复处理。
   */
  async handleDispatch(payload: QqPayload, flowTraceId?: string): Promise<QqDispatchOutcome> {
    const d = payload.d as QqC2cMessageData | undefined;
    const eventId = payload.id ?? '';
    if (!eventId) {
      this.deps.errors.add('qq.inbound', 'dispatch event without id', { code: 'bad_request' });
      this.deps.flowTrace?.fail(flowTraceId, 'qq.event.invalid', 'dispatch event without id');
      return { ack: { op: QQ_OP_ACK }, eventStatus: 'failed' };
    }
    const openid = d?.author?.user_openid?.trim() || d?.author?.openid?.trim() || null;
    const claimed = this.deps.events.markReceived({
      channel: QQ_CHANNEL_NAME,
      eventId,
      remoteMessageId: d?.id ?? null,
      eventType: payload.t ?? 'dispatch',
      conversationKey: openid
    });
    this.deps.flowTrace?.stage(flowTraceId, 'qq.channel_event.received', 'ok', { eventId });
    if (!claimed.inserted) {
      // 重推 / 重放：幂等消费，不重复写消息、不重复触发模型。
      this.deps.metrics?.record('qq', 'inbound.duplicate');
      this.deps.flowTrace?.block(flowTraceId, 'qq.duplicate', 'duplicate_webhook');
      return { ack: { op: QQ_OP_ACK }, eventStatus: claimed.row.status };
    }
    try {
      if (payload.t === 'C2C_MESSAGE_CREATE' && openid) {
        const identity = resolveQqIdentity(
          { config: this.deps.config, identities: this.deps.identities },
          { externalUserId: openid, externalConversationId: openid, scene: 'c2c' }
        );
        if (identity.role === 'denied') {
          this.deps.metrics?.record('qq', 'inbound.rejected_user');
          this.deps.events.markRejected(QQ_CHANNEL_NAME, eventId, identity.reason);
          this.deps.flowTrace?.block(flowTraceId, 'qq.identity.rejected', identity.reason);
          return { ack: { op: QQ_OP_ACK }, eventStatus: 'rejected' };
        }
        const mediaParts: InputPart[] = [];
        for (const attachment of d?.attachments ?? []) {
          try {
            const part = await downloadQqImageAttachment(attachment, {
              mediaStore: this.deps.mediaStore,
              fetchImpl: this.deps.fetchImpl,
              maxBytes: this.deps.maxAttachmentBytes
            });
            if (part) mediaParts.push(part);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.deps.errors.add('qq.inbound', message, { eventId, code: 'attachment_download_failed' });
            this.deps.metrics?.record('qq', 'inbound.attachment_failed');
          }
        }
        const inbound = c2cMessageToIngress(payload, identity, mediaParts);
        if (!inbound) {
          // 空内容 / 缺消息 id：不产生消息，视为已消费。
          this.deps.events.markProcessed(QQ_CHANNEL_NAME, eventId, null);
          this.deps.flowTrace?.block(flowTraceId, 'qq.message.empty', 'empty_or_missing_message');
          return { ack: { op: QQ_OP_ACK }, eventStatus: 'processed' };
        }
        const quoted = typeof inbound.ingress.metadata?.quotedQqMsgId === 'string' ? inbound.ingress.metadata.quotedQqMsgId : null;
        const replyTo = resolveQuoteReplyTo(quoted, this.deps.events);
        const result = await this.deps.ingress.accept({
          ...inbound.ingress,
          replyTo,
          metadata: { ...inbound.ingress.metadata, ...(flowTraceId ? { flowTraceId } : {}) }
        });
        for (const part of mediaParts) {
          if (part.type !== 'image') continue;
          this.deps.jobs.enqueue('sticker.auto-collect', { mediaId: part.mediaId, messageId: result.messageId }, {
            maxAttempts: 2,
            runAfter: new Date(Date.now() + 12_000).toISOString()
          });
        }
        this.deps.events.markProcessed(QQ_CHANNEL_NAME, eventId, result.messageId);
        this.deps.metrics?.record('qq', 'inbound.accepted');
        this.deps.flowTrace?.stage(flowTraceId, 'qq.ingress.accepted', 'ok', { messageId: result.messageId });
        return { ack: { op: QQ_OP_ACK }, eventStatus: 'processed' };
      }
      // 其它事件类型暂不订阅；记录后视为已消费，避免平台反复重推。
      this.deps.events.markProcessed(QQ_CHANNEL_NAME, eventId, null);
      this.deps.flowTrace?.block(flowTraceId, 'qq.event.ignored', payload.t ?? 'unsupported_event');
      return { ack: { op: QQ_OP_ACK }, eventStatus: 'processed' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.events.markFailed(QQ_CHANNEL_NAME, eventId, 'ingress_failed');
      this.deps.errors.add('qq.inbound', message, { eventId, code: 'ingress_failed' });
      this.deps.flowTrace?.fail(flowTraceId, 'qq.ingress.failed', message);
      return { ack: { op: QQ_OP_ACK }, eventStatus: 'failed' };
    }
  }
}
