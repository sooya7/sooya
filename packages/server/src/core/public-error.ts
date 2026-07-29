import { sortableId } from '../util/ids.js';

export type PublicFailureCode = 'internal_error' | 'reply_failed' | 'provider_unavailable';

export interface PublicFailure {
  incidentId: string;
  code: PublicFailureCode;
  message: string;
}

const PUBLIC_MESSAGES: Record<PublicFailureCode, string> = {
  internal_error: '服务器暂时无法处理请求，请稍后重试。',
  reply_failed: '回复生成失败，请稍后重试。',
  provider_unavailable: '模型服务暂时不可用，请稍后重试。'
};

export function publicFailure(code: PublicFailureCode): PublicFailure {
  return {
    incidentId: sortableId('inc'),
    code,
    message: PUBLIC_MESSAGES[code]
  };
}

export function redactDiagnostic(error: unknown): string {
  const value =
    error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
      : String(error);

  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(
      /(\b(?:api[-_]?key|apikey|authorization|token|secret|password)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:api[-_]?key|apikey|access_token|token|secret|password)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\s\r\n]+/g, '[PATH]')
    .replace(/(^|[\s("'=])\/(?:[^/\s)"']+\/)+[^/\s)"']*/gm, '$1[PATH]')
    .slice(0, 4000);
}
