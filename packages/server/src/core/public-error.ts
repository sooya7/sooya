import { sortableId } from '../util/ids.js';

export type PublicFailureCode = 'internal_error' | 'reply_failed' | 'provider_unavailable';

export interface PublicFailure {
  incidentId: string;
  code: PublicFailureCode;
  message: string;
}

export interface SafeApplicationError extends Error {
  statusCode: number;
  code: string;
  sooyaPublicSafe: true;
}

const PUBLIC_MESSAGES: Record<PublicFailureCode, string> = {
  internal_error: '服务器暂时无法处理请求，请稍后重试。',
  reply_failed: '回复生成失败，请稍后重试。',
  provider_unavailable: '模型服务暂时不可用，请稍后重试。'
};

const SECRET_NAME =
  '(?:api[-_]?key|apikey|authorization|access_token|refresh_token|token|client_secret|secret|password)';
const SECRET_QUERY_NAME = /^(?:api[-_]?key|apikey|access_token|refresh_token|token|client_secret|secret|password)$/i;

export function publicFailure(code: PublicFailureCode): PublicFailure {
  return {
    incidentId: sortableId('inc'),
    code,
    message: PUBLIC_MESSAGES[code]
  };
}

export function isSafeApplicationError(error: unknown): error is SafeApplicationError {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<SafeApplicationError>;
  return (
    candidate.sooyaPublicSafe === true &&
    Number.isInteger(candidate.statusCode) &&
    candidate.statusCode! >= 400 &&
    candidate.statusCode! < 500 &&
    typeof candidate.code === 'string' &&
    /^[a-z][a-z0-9_]{1,63}$/.test(candidate.code) &&
    typeof candidate.message === 'string' &&
    candidate.message.length > 0 &&
    candidate.message.length <= 200 &&
    !/[\r\n]/.test(candidate.message)
  );
}

export function redactDiagnostic(error: unknown): string {
  const value =
    error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`
      : String(error);

  return redactUrls(value)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(
      new RegExp(`(\\b${SECRET_NAME}\\b\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, 'gi'),
      '$1[REDACTED]'
    )
    .replace(/file:\/\/\/[^\s)"']+/gi, '[PATH]')
    .replace(
      /\b[A-Za-z]:[\\/][^,;\r\n)"']+?(?::\d+:\d+)?(?=[,;)\r\n]|$|\s+[A-Za-z][A-Za-z _-]{0,40}:\s)/g,
      '[PATH]'
    )
    .replace(
      /(^|[\s("'=])\/(?:[^/,;\r\n)"']+\/)+[^,;)\r\n"']+?(?::\d+:\d+)?(?=[,;)\r\n]|$|\s+[A-Za-z][A-Za-z _-]{0,40}:\s)/gm,
      '$1[PATH]'
    )
    .slice(0, 4000);
}

function redactUrls(input: string): string {
  return input.replace(/\bhttps?:\/\/[^\s)"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      url.username = '';
      url.password = '';
      for (const key of [...url.searchParams.keys()]) {
        if (SECRET_QUERY_NAME.test(key)) url.searchParams.set(key, '[REDACTED]');
      }
      return url.toString();
    } catch {
      return '[URL]';
    }
  });
}
