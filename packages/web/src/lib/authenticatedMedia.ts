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

/*
 * 媒体一直是「每次挂载都重新下载」：`cache: 'no-store'` 关掉了 HTTP 缓存，组件卸载又
 * 立刻 revokeObjectURL，所以切一次标签页、画廊往回滚一屏，同一批图就整批重下——画廊
 * 一页 60 张原图，代价是几十 MB。
 *
 * 这里加一层进程内缓存：按「不带凭证的路径 + 作用域」缓存 blob 与它的 object URL，用
 * 引用计数决定谁还在用，同一路径的并发请求合并成一个。卸载只减引用不撤销 URL，撤销留
 * 给淘汰逻辑，所以回到上一屏是瞬时的。
 *
 * 上限是必要的：blob 占的是内存，画廊翻十页就能吃掉几百 MB。超过上限时按最久未用淘汰，
 * 且只淘汰引用为 0 的条目——正在显示的图片被撤销会变成裂图。
 */
export const MEDIA_CACHE_MAX_BYTES = 96 * 1024 * 1024;
export const MEDIA_CACHE_MAX_ENTRIES = 240;

interface MediaCacheEntry {
  key: string;
  scope: MediaAuthScope;
  url: string;
  blob: Blob;
  contentType: string;
  refs: number;
  bytes: number;
  used: number;
}

const mediaCache = new Map<string, MediaCacheEntry>();
const inflight = new Map<string, Promise<MediaCacheEntry>>();
const scopeGeneration: Record<MediaAuthScope, number> = { user: 0, admin: 0 };
let cachedBytes = 0;
let clock = 0;

export function mediaCacheKey(path: string, options: Pick<AuthenticatedMediaOptions, 'scope' | 'expected'>): string {
  return `${options.scope}|${options.expected}|${credentialFreeMediaPath(path)}`;
}

function touch(entry: MediaCacheEntry): void {
  entry.used = ++clock;
}

function evictIfNeeded(): void {
  if (cachedBytes <= MEDIA_CACHE_MAX_BYTES && mediaCache.size <= MEDIA_CACHE_MAX_ENTRIES) return;
  const idle = [...mediaCache.values()].filter((entry) => entry.refs <= 0).sort((a, b) => a.used - b.used);
  for (const entry of idle) {
    if (cachedBytes <= MEDIA_CACHE_MAX_BYTES && mediaCache.size <= MEDIA_CACHE_MAX_ENTRIES) return;
    drop(entry);
  }
}

function drop(entry: MediaCacheEntry): void {
  mediaCache.delete(entry.key);
  cachedBytes -= entry.bytes;
  blobByObjectUrl.delete(entry.url);
  URL.revokeObjectURL(entry.url);
}

/** 命中则同步返回并加一个引用，让重新挂载不闪空白。 */
export function takeCachedMedia(path: string, options: Pick<AuthenticatedMediaOptions, 'scope' | 'expected'>): AuthenticatedMediaResult | null {
  const entry = mediaCache.get(mediaCacheKey(path, options));
  if (!entry) return null;
  entry.refs += 1;
  touch(entry);
  return { url: entry.url, blob: entry.blob, contentType: entry.contentType };
}

/** 取一份媒体并持有引用；用完必须 releaseCachedMedia(path, options)。 */
export async function acquireAuthenticatedMedia(
  path: string,
  options: AuthenticatedMediaOptions
): Promise<AuthenticatedMediaResult> {
  const hit = takeCachedMedia(path, options);
  if (hit) return hit;
  const key = mediaCacheKey(path, options);
  const generation = scopeGeneration[options.scope];
  const inflightKey = `${key}|generation:${generation}`;
  // 同一路径的并发请求只发一次；每个等待者各自加一个引用。
  const pending = inflight.get(inflightKey) ?? (async () => {
    try {
      const result = await fetchAuthenticatedMediaWithRetry(path, { ...options, signal: undefined });
      if (scopeGeneration[options.scope] !== generation) {
        releaseMediaUrl(result.url);
        throw new AuthenticatedMediaError('stale_auth', null, '媒体访问凭证已更新，请重试');
      }
      const entry: MediaCacheEntry = {
        key,
        scope: options.scope,
        url: result.url,
        blob: result.blob,
        contentType: result.contentType,
        refs: 0,
        bytes: result.blob.size,
        used: ++clock
      };
      mediaCache.set(key, entry);
      cachedBytes += entry.bytes;
      evictIfNeeded();
      return entry;
    } finally {
      inflight.delete(inflightKey);
    }
  })();
  inflight.set(inflightKey, pending);
  const entry = await pending;
  if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
  entry.refs += 1;
  touch(entry);
  return { url: entry.url, blob: entry.blob, contentType: entry.contentType };
}

/** 放开引用。不撤销 URL：留在缓存里等淘汰，回到上一屏才是瞬时的。 */
export function releaseCachedMedia(path: string, options: Pick<AuthenticatedMediaOptions, 'scope' | 'expected'>): void {
  const entry = mediaCache.get(mediaCacheKey(path, options));
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  evictIfNeeded();
}

/** 退出登录或换令牌时清对应作用域，别把上一份凭证的私有媒体留在内存里。 */
export function clearMediaCache(scope?: MediaAuthScope): void {
  const scopes: MediaAuthScope[] = scope ? [scope] : ['user', 'admin'];
  for (const current of scopes) scopeGeneration[current] += 1;
  for (const entry of [...mediaCache.values()]) {
    if (!scope || entry.scope === scope) drop(entry);
  }
  if (!scope) cachedBytes = 0;
}

export function mediaCacheStats(): { entries: number; bytes: number; held: number } {
  return {
    entries: mediaCache.size,
    bytes: cachedBytes,
    held: [...mediaCache.values()].filter((entry) => entry.refs > 0).length
  };
}


/*
 * 气泡里的图最宽 260 CSS 像素，画廊网格更小，但以前拿的都是原图——一张生成图动辄
 * 2 MB，首屏要等它整张下完才成像。服务端支持 `?w=` 缩略图档位（240/480/960，按需
 * 向上取档，原图更窄时照旧回原图），这里按显示宽度和设备像素比换算出请求宽度。
 * 上限取 2 倍：3 倍屏再多要一档，收益只有肉眼难辨的锐度，代价是几倍字节。
 */
export function mediaThumbnailPath(path: string, cssWidth: number): string {
  if (!path || path.startsWith('blob:') || path.startsWith('data:')) return path;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const parsed = new URL(path, 'http://sooya.local');
  if (!/^\/api\/media\/[A-Za-z0-9_-]{1,64}$/.test(parsed.pathname)) return path;
  parsed.searchParams.set('w', String(Math.max(1, Math.round(cssWidth * dpr))));
  return parsed.origin === 'http://sooya.local' ? `${parsed.pathname}${parsed.search}` : parsed.toString();
}

/** 聊天气泡与头像的显示宽度（CSS 像素），换算请求宽度用。 */
export const BUBBLE_IMAGE_CSS_WIDTH = 260;
export const AVATAR_IMAGE_CSS_WIDTH = 96;

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
    // 服务端对每个 id 的字节是不变的，并带上 ETag 与 immutable，所以让浏览器缓存
    response = await fetch(safePath, { headers, signal: options.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AuthenticatedMediaError('network', null, '媒体加载失败，请检查网络连接');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) clearMediaCache(options.scope);
    throw responseError(response.status);
  }
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
 * readable, and a permanent 404 costs only two extra requests. `blob` and `empty`
 * are the same story seen from the body: a truncated or still-growing file aborts
 * the read, which used to surface as a dead "媒体内容读取失败" with no way back.
 */
const RETRIABLE_CODES = new Set(['network', 'server', 'rate_limit', 'missing', 'blob', 'empty', 'stale_auth']);

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
  // 文件永远走 blob URL + <a download> 下载，从不内联渲染，所以 text/html /
  // application/json 是合法下载内容——拒绝它们会误杀网页快照、JSON 导出等正常文件。
  // image / audio 仍严格校验，防止把别的类型当图片渲染。
  if (expected === 'file') return true;
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

