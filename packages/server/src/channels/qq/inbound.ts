import type { MessageIngressInput } from '../../core/message-ingress.js';
import type { QqIdentityDecision } from './mapping.js';
import { QQ_CHANNEL_NAME, type QqC2cMessageData, type QqPayload } from './types.js';

/*
 * QQ 原始 Event → SOOYA 标准输入（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §5.3）。
 * QQ 原始事件不允许直接进入 Replier；统一由 MessageIngressService 接手。
 * 第一阶段：C2C / 私聊文字；媒体（图片/文件/语音/表情）在 PR4 接入。
 */

export interface QqInboundResult {
  ingress: MessageIngressInput;
  /** 被引用 QQ 消息对应的 SOOYA 消息 id（quote 解析后回填）。 */
  replyTo: string | null;
}

/** clientMsgId 加通道前缀，避免与 Web 客户端 id 空间撞车。 */
export function qqClientMessageId(qqMsgId: string): string {
  return `${QQ_CHANNEL_NAME}:${qqMsgId}`;
}

export function c2cMessageToIngress(
  payload: QqPayload,
  identity: Extract<QqIdentityDecision, { role: 'owner' | 'user' }>
): QqInboundResult | null {
  const d = payload.d as QqC2cMessageData | undefined;
  const openid = d?.author?.user_openid?.trim() || d?.author?.openid?.trim();
  if (!openid || !d?.id) return null;
  const text = String(d.content ?? '').trim();
  if (!text) return null; // PR2 只处理文字；纯媒体消息等 PR4。
  return {
    ingress: {
      clientMessageId: qqClientMessageId(d.id),
      source: 'qq',
      conversationId: identity.sooyaConversationId,
      senderId: openid,
      content: [{ type: 'text', text }],
      metadata: {
        qqMsgId: d.id,
        qqEventId: payload.id ?? null,
        qqTimestamp: d.timestamp ?? null,
        quotedQqMsgId: d.message_reference?.message_id ?? null
      }
    },
    replyTo: null
  };
}

/** 解析被引用 QQ 消息对应的 SOOYA 消息 id；查不到（事件被修剪/非本机消息）则返回 null。 */
export function resolveQuoteReplyTo(
  quotedQqMsgId: string | null | undefined,
  channelEvents: { findByRemoteMessageId(remoteMessageId: string): { message_id: string | null } | undefined }
): string | null {
  if (!quotedQqMsgId) return null;
  // 被引用消息必须经本机处理过（channel_event.message_id 已回填）才可能建立引用。
  const event = channelEvents.findByRemoteMessageId(quotedQqMsgId);
  return event?.message_id ?? null;
}