/*
 * QQ 通道错误。全部经过脱敏后进入 error_log（qq.verify / qq.inbound / qq.send…），
 * 只允许携带 event id / message id / HTTP status / error code / retry 数，
 * 永不携带 Secret、token、完整签名、用户消息正文。
 */
export type QqErrorCode =
  | 'signature_invalid'
  | 'signature_expired'
  | 'bad_request'
  | 'user_not_authorized'
  | 'event_unsupported'
  | 'ingress_failed';

export class QqVerifyError extends Error {
  constructor(
    readonly code: QqErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'QqVerifyError';
  }
}

/** 事件签名校验失败（HTTP 401，安全日志）。 */
export function signatureError(
  reason: 'invalid' | 'expired' | 'malformed',
  details: Record<string, unknown> = {}
): QqVerifyError {
  return new QqVerifyError(reason === 'expired' ? 'signature_expired' : 'signature_invalid', `qq signature ${reason}`, details);
}