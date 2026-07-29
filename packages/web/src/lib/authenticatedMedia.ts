export type MediaAuthScope = 'user' | 'admin';
export type ExpectedMedia = 'image' | 'audio' | 'file';

export class AuthenticatedMediaError extends Error {
  constructor(readonly code: string, readonly status: number | null, message: string) {
    super(message);
    this.name = 'AuthenticatedMediaError';
  }
}

export interface AuthenticatedMediaOptions {
  scope: MediaAuthScope;
  token: string | null;
  expected: ExpectedMedia;
  signal?: AbortSignal;
}

export interface AuthenticatedMediaResult {
  url: string;
  blob: Blob;
  contentType: string;
}

const blobByObjectUrl = new Map<string, Blob>();

export function credentialFreeMediaPath(path: string): string {
  const parsed = new URL(path, 'http://sooya.local');
  for (const key of [...parsed.searchParams.keys()]) {
    if (/^(?:admin_)?token$/i.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  return parsed.origin === 'http://sooya.local'
    ? `${parsed.pathname}${parsed.search}`
    : parsed.toString();
}

export async function fetchAuthenticatedMedia(
  path: string,
  options: AuthenticatedMediaOptions
): Promise<AuthenticatedMediaResult> {
  const safePath = credentialFreeMediaPath(path);
  const baseOrigin = typeof window === 'undefined' ? 'http://sooya.local' : window.location.origin;
  const target = new URL(safePath, baseOrigin);
  if (target.origin !== baseOrigin) {
    throw new AuthenticatedMediaError('origin', null, '拒绝向站外媒体发送访问凭证');
  }
  const headers = new Headers();
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  let response: Response;
  try {
    response = await fetch(safePath, { headers, signal: options.signal, cache: 'no-store' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AuthenticatedMediaError('network', null, '媒体加载失败，请检查网络连接');
  }
  if (!response.ok) throw responseError(response.status);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!matchesExpectedType(contentType, options.expected)) {
    throw new AuthenticatedMediaError('content_type', response.status, '媒体类型不匹配');
  }
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new AuthenticatedMediaError('blob', response.status, '媒体内容读取失败');
  }
  if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  if (blob.size === 0) throw new AuthenticatedMediaError('empty', response.status, '媒体内容为空');
  let url: string;
  try {
    url = URL.createObjectURL(blob);
  } catch {
    throw new AuthenticatedMediaError('blob_url', response.status, '媒体预览创建失败');
  }
  blobByObjectUrl.set(url, blob);
  return { url, blob, contentType };
}

/**
 * Failures worth another attempt. `missing` is included on purpose: a freshly
 * generated image can be announced over the stream a beat before its bytes are
 * readable, and a permanent 404 costs only two extra requests.
 */
const RETRIABLE_CODES = new Set(['network', 'server', 'rate_limit', 'missing']);

export function isRetriableMediaError(error: unknown): boolean {
  return error instanceof AuthenticatedMediaError && RETRIABLE_CODES.has(error.code);
}

/** Backoff before each retry. Kept short — a chat bubble is waiting on this. */
export const MEDIA_RETRY_DELAYS_MS: readonly number[] = [400, 1200];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchAuthenticatedMediaWithRetry(
  path: string,
  options: AuthenticatedMediaOptions,
  sleep: (ms: number) => Promise<void> = wait
): Promise<AuthenticatedMediaResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchAuthenticatedMedia(path, options);
    } catch (error) {
      const delay = MEDIA_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetriableMediaError(error)) throw error;
      await sleep(delay);
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    }
  }
}

export function releaseMediaUrl(url: string | null | undefined): void {
  if (url?.startsWith('blob:')) {
    blobByObjectUrl.delete(url);
    URL.revokeObjectURL(url);
  }
}

export function blobForMediaUrl(url: string): Blob | null {
  return blobByObjectUrl.get(url) ?? null;
}

export function safeDownloadName(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').trim().slice(0, 120);
  return cleaned || fallback;
}

function matchesExpectedType(contentType: string, expected: ExpectedMedia): boolean {
  if (expected === 'file') return contentType !== 'text/html' && contentType !== 'application/json';
  return contentType.startsWith(`${expected}/`);
}

function responseError(status: number): AuthenticatedMediaError {
  if (status === 401 || status === 403) return new AuthenticatedMediaError('auth', status, '媒体访问凭证已失效或权限不足');
  if (status === 404) return new AuthenticatedMediaError('missing', status, '媒体不存在');
  if (status === 410) return new AuthenticatedMediaError('gone', status, '媒体已失效');
  if (status === 429) return new AuthenticatedMediaError('rate_limit', status, '媒体请求过于频繁');
  if (status >= 500) return new AuthenticatedMediaError('server', status, '媒体服务暂时不可用');
  return new AuthenticatedMediaError('http', status, `媒体请求失败（${status}）`);
}
