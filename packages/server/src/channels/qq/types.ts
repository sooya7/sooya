/*
 * QQ 官方 Bot webhook 事件类型（bot.q.qq.com api-v2，2026-08 核对）。
 * 回调负载为通用 Payload：{ id, op, d, s, t }。
 * - op 0  = Dispatch：事件推送，t 为事件类型，d 为事件内容
 * - op 13 = URL 验证：d 为 { plain_token, event_ts }，需回签名
 * - HTTP 回调模式收到事件后回包 { "op": 12 } 表示已接收
 */
export const QQ_OP_DISPATCH = 0;
export const QQ_OP_VALIDATION = 13;
export const QQ_OP_ACK = 12;

export interface QqPayload {
  id?: string;
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export interface QqValidationData {
  plain_token?: string;
  event_ts?: string;
}

export interface QqAuthor {
  /** C2C/群聊事件中用户 openid */
  user_openid?: string;
  /** 频道场景用户 id */
  openid?: string;
}

export interface QqAttachment {
  content_type?: string;
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  url?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

export interface QqMessageReference {
  message_id?: string;
  message_seq?: number;
  ignore_get_message_error?: boolean;
}

/** 单聊消息事件（C2C_MESSAGE_CREATE）的 d 字段。 */
export interface QqC2cMessageData {
  id?: string;
  author?: QqAuthor;
  content?: string;
  timestamp?: string;
  attachments?: QqAttachment[];
  message_reference?: QqMessageReference;
}

export type QqEventType = 'C2C_MESSAGE_CREATE' | string;

export const QQ_CHANNEL_NAME = 'qq';
export const QQ_SCENE_C2C = 'c2c';