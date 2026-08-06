import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AuthenticatedMediaError,
  blobForMediaUrl,
  fetchAuthenticatedMedia,
  fetchAuthenticatedMediaWithRetry,
  isRetriableMediaError,
  releaseMediaUrl,
  acquireAuthenticatedMedia,
  releaseCachedMedia,
  takeCachedMedia,
  clearMediaCache,
  mediaCacheStats,
  MEDIA_CACHE_MAX_ENTRIES,
  MEDIA_RETRY_DELAYS_MS,
  mediaThumbnailPath,
  BUBBLE_IMAGE_CSS_WIDTH
} from './authenticatedMedia.js';
import { mediaUrl } from './api.js';
import { adminMediaUrl } from './features.js';
import { buildStreamRequest } from './stream.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authenticated media', () => {
  /*
   * 气泡最宽 260 CSS 像素，以前拿的是原图。缩略图路径必须只作用在媒体端点上，
   * 且缓存键按查询串区分，否则缩略图和原图会互相顶掉。
   */
  it('按显示宽度和设备像素比给媒体地址加上缩略图档位', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1, location: { origin: 'https://echo.example' } });
    expect(mediaThumbnailPath('/api/media/media_1', BUBBLE_IMAGE_CSS_WIDTH)).toBe('/api/media/media_1?w=260');
    vi.stubGlobal('window', { devicePixelRatio: 3, location: { origin: 'https://echo.example' } });
    // 3 倍屏封顶到 2 倍：再高一档只换来肉眼难辨的锐度。
    expect(mediaThumbnailPath('/api/media/media_1', BUBBLE_IMAGE_CSS_WIDTH)).toBe('/api/media/media_1?w=520');
  });

  it('缩略图改写只作用于媒体端点，blob 与其他路径原样返回', () => {
    vi.stubGlobal('window', { devicePixelRatio: 1, location: { origin: 'https://echo.example' } });
    expect(mediaThumbnailPath('blob:https://echo.example/abc', 260)).toBe('blob:https://echo.example/abc');
    expect(mediaThumbnailPath('/api/stickers/sticker_1', 260)).toBe('/api/stickers/sticker_1');
    expect(mediaThumbnailPath('/api/media/media_1/meta', 260)).toBe('/api/media/media_1/meta');
    expect(mediaThumbnailPath('', 260)).toBe('');
  });

  it('缩略图和原图在媒体缓存里是两个条目', async () => {
    clearMediaCache();
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      calls.push(String(input));
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }), { status: 200, headers: { 'content-type': 'image/webp' } });
    }));
    await acquireAuthenticatedMedia('/api/media/media_1?w=260', { scope: 'user', token: 't', expected: 'image' });
    await acquireAuthenticatedMedia('/api/media/media_1', { scope: 'user', token: 't', expected: 'image' });
    expect(calls).toEqual(['/api/media/media_1?w=260', '/api/media/media_1']);
    expect(mediaCacheStats().entries).toBe(2);
    clearMediaCache();
  });

  it('never appends long-lived credentials to media URLs', () => {
    expect(mediaUrl('/api/media/media_1?token=user-secret&v=1')).toBe('/api/media/media_1?v=1');
    expect(adminMediaUrl('/api/media/media_1?admin_token=admin-secret#leak')).toBe('/api/media/media_1');
  });

  it('authenticates the event stream by header without putting credentials in its URL', () => {
    const request = buildStreamRequest(42, 'chat-secret');
    expect(request.url).toBe('/api/stream?lastEventId=42');
    expect(request.url).not.toContain('chat-secret');
    expect(new Headers(request.init.headers).get('authorization')).toBe('Bearer chat-secret');
    expect(request.init.cache).toBe('no-store');
  });

  it('keeps protected media network-only in the service worker', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8');
    const mediaBranch = source.slice(source.indexOf("url.pathname.startsWith('/api/media/')"), source.indexOf("if (url.pathname.startsWith('/api/'))"));
    expect(mediaBranch).toContain('fetch(request)');
    expect(mediaBranch).not.toContain('cache.put');
    expect(mediaBranch).not.toContain('cache.match');
    // The shell list is injected at build time; the source must keep the placeholder
    // and derive the cache name from it, so a new build cannot reuse a stale cache.
    expect(source).toContain('const BUILD_MANIFEST = /*__SOOYA_BUILD_MANIFEST__*/');
    expect(source).toContain('const SHELL_CACHE = `sooya-shell-${BUILD_MANIFEST.version}`');
    expect(source).toContain("keys.filter((key) => key !== SHELL_CACHE && key.startsWith('sooya'))");
  });

  it('hands over only when the page asks, and keeps the old shell until it confirms', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8');
    const install = source.slice(source.indexOf("addEventListener('install'"), source.indexOf("addEventListener('activate'"));
    const activate = source.slice(source.indexOf("addEventListener('activate'"), source.indexOf("addEventListener('message'"));
    // Taking over unasked would swap the app out from under a live conversation.
    // Matching the call, not the word, so an explanatory comment cannot satisfy it.
    expect(install).not.toMatch(/skipWaiting\s*\(/);
    // Deleting the previous shell before the reload succeeds leaves nothing to fall back to.
    expect(activate).not.toMatch(/caches\.delete\s*\(/);
    expect(activate).not.toMatch(/deleteObsoleteShellCaches\s*\(/);
    expect(source).toContain("if (type === 'SKIP_WAITING')");
    expect(source).toContain("if (type === 'CLIENT_READY')");
    expect(source).toContain('event.waitUntil(deleteObsoleteShellCaches())');
    // Credentialed requests are per-user and must never reach a shared cache.
    expect(source).toContain("request.headers.has('authorization') || url.searchParams.has('token')");
  });
  it('uses scoped headers without putting credentials in the URL', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:media-1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/media/media_1?v=abc');
      expect(url).not.toMatch(/token/i);
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer chat-secret');
      return new Response(new Blob(['image'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      });
    }));

    const result = await fetchAuthenticatedMedia('/api/media/media_1?v=abc', {
      scope: 'user',
      token: 'chat-secret',
      expected: 'image'
    });

    expect(result.url).toBe('blob:media-1');
    expect(blobForMediaUrl(result.url)).toBe(result.blob);
    expect(create).toHaveBeenCalledTimes(1);
    releaseMediaUrl(result.url);
    expect(blobForMediaUrl(result.url)).toBeNull();
  });

  it('uses the admin scope without exposing the admin token', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:admin');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).not.toContain('admin-secret');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer admin-secret');
      return new Response(new Blob(['image'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } });
    }));
    const result = await fetchAuthenticatedMedia('/api/media/avatar', { scope: 'admin', token: 'admin-secret', expected: 'image' });
    releaseMediaUrl(result.url);
  });

  it('never forwards credentials to a cross-origin media URL', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(fetchAuthenticatedMedia('https://example.invalid/private.png', {
      scope: 'admin',
      token: 'admin-secret',
      expected: 'image'
    })).rejects.toMatchObject({ code: 'origin' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'missing'],
    [410, 'gone'],
    [503, 'server']
  ])('classifies HTTP %i without exposing credentials', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    await expect(fetchAuthenticatedMedia('/api/media/media_1', {
      scope: 'user',
      token: 'never-log-this',
      expected: 'image'
    })).rejects.toMatchObject({ code, status });
  });

  it('classifies network failures without including the token in the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket failed'); }));
    try {
      await fetchAuthenticatedMedia('/api/media/media_1', {
        scope: 'user',
        token: 'never-log-this',
        expected: 'image'
      });
      throw new Error('expected media request to fail');
    } catch (failure) {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain('never-log-this');
      expect(failure).toMatchObject({ code: 'network' });
    }
  });

  it('does not create an object URL after cancellation', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unused');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }));
    const controller = new AbortController();
    controller.abort();
    await expect(fetchAuthenticatedMedia('/api/media/media_1', {
      scope: 'user',
      token: 'secret',
      expected: 'image',
      signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects unexpected content types and revokes released URLs', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:bad');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(fetchAuthenticatedMedia('/api/media/media_1', {
      scope: 'user',
      token: 'secret',
      expected: 'image'
    })).rejects.toThrow('媒体类型不匹配');
    releaseMediaUrl('blob:old');
    expect(revoke).toHaveBeenCalledWith('blob:old');
    expect(blobForMediaUrl('blob:old')).toBeNull();
  });

  it('delivers html and json as downloadable files (never rendered inline)', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:file-ok');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>snapshot</html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(fetchAuthenticatedMedia('/api/media/file_1', { scope: 'user', token: 'secret', expected: 'file' })).resolves.toMatchObject({ contentType: 'text/html' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(fetchAuthenticatedMedia('/api/media/file_2', { scope: 'user', token: 'secret', expected: 'file' })).resolves.toMatchObject({ contentType: 'application/json' });
  });

  it('rejects empty media and reports Object URL creation failures safely', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })));
    await expect(fetchAuthenticatedMedia('/api/media/empty', {
      scope: 'user',
      token: 'never-log-this',
      expected: 'image'
    })).rejects.toMatchObject({ code: 'empty' });

    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { throw new Error('object URL unavailable'); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })));
    const failure = await fetchAuthenticatedMedia('/api/media/image', {
      scope: 'user',
      token: 'never-log-this',
      expected: 'image'
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'blob_url' });
    expect((failure as Error).message).not.toContain('never-log-this');
  });
});

describe('media retry', () => {
  const options = { scope: 'user', token: 'chat-secret', expected: 'image' } as const;
  const png = () => new Response(new Blob(['image'], { type: 'image/png' }), {
    status: 200,
    headers: { 'content-type': 'image/png' }
  });
  const slept: number[] = [];
  const sleep = async (ms: number) => { slept.push(ms); };

  afterEach(() => { slept.length = 0; });

  it('classifies which failures deserve another attempt', () => {
    expect(isRetriableMediaError(new AuthenticatedMediaError('missing', 404, ''))).toBe(true);
    expect(isRetriableMediaError(new AuthenticatedMediaError('network', null, ''))).toBe(true);
    expect(isRetriableMediaError(new AuthenticatedMediaError('server', 503, ''))).toBe(true);
    expect(isRetriableMediaError(new AuthenticatedMediaError('stale_auth', null, ''))).toBe(true);
    expect(isRetriableMediaError(new AuthenticatedMediaError('auth', 401, ''))).toBe(false);
    expect(isRetriableMediaError(new AuthenticatedMediaError('gone', 410, ''))).toBe(false);
    expect(isRetriableMediaError(new DOMException('aborted', 'AbortError'))).toBe(false);
  });

  it('recovers a 404 that becomes readable on a later attempt', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retry-1');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(png());
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchAuthenticatedMediaWithRetry('/api/media/late', options, sleep);

    expect(result.url).toBe('blob:retry-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([MEDIA_RETRY_DELAYS_MS[0]]);
    releaseMediaUrl(result.url);
  });

  it('gives up after the configured attempts and reports the last failure', async () => {
    const fetchMock = vi.fn(async () => new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAuthenticatedMediaWithRetry('/api/media/gone', options, sleep))
      .rejects.toMatchObject({ code: 'missing' });
    expect(fetchMock).toHaveBeenCalledTimes(MEDIA_RETRY_DELAYS_MS.length + 1);
    expect(slept).toEqual([...MEDIA_RETRY_DELAYS_MS]);
  });

  it('does not retry a permanent failure', async () => {
    const fetchMock = vi.fn(async () => new Response('denied', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAuthenticatedMediaWithRetry('/api/media/private', options, sleep))
      .rejects.toMatchObject({ code: 'auth' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('stops retrying once the caller aborts', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return new Response('missing', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAuthenticatedMediaWithRetry(
      '/api/media/late',
      { ...options, signal: controller.signal },
      sleep
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/*
 * 这些用例守的是「同一张图不该下载两次」。之前每个组件挂载都自己 fetch 一遍、卸载就撤销
 * blob URL，所以切标签页或画廊往回滚一屏，一页 60 张原图会整批重传。
 */
describe('媒体缓存', () => {
  const opts = { scope: 'user' as const, expected: 'image' as const, token: 'chat-secret' };
  const key = { scope: 'user' as const, expected: 'image' as const };
  let created = 0;

  function stubMedia(bytes = 'image') {
    created = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:cached-${++created}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Blob([bytes], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => clearMediaCache());

  it('第二次取同一路径不再发请求，且复用同一个 blob URL', async () => {
    const fetchMock = stubMedia();
    const first = await acquireAuthenticatedMedia('/api/media/m1', opts);
    const second = await acquireAuthenticatedMedia('/api/media/m1', opts);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.url).toBe(first.url);
    expect(mediaCacheStats()).toMatchObject({ entries: 1, held: 1 });
  });

  it('并发取同一路径合并成一次请求', async () => {
    const fetchMock = stubMedia();
    const results = await Promise.all([
      acquireAuthenticatedMedia('/api/media/m1', opts),
      acquireAuthenticatedMedia('/api/media/m1', opts),
      acquireAuthenticatedMedia('/api/media/m1', opts)
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.url)).size).toBe(1);
  });

  it('放开引用不撤销 URL：回到上一屏是命中而不是重下', async () => {
    const fetchMock = stubMedia();
    const first = await acquireAuthenticatedMedia('/api/media/m1', opts);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    releaseCachedMedia('/api/media/m1', key);
    expect(revoke).not.toHaveBeenCalled();
    const hit = takeCachedMedia('/api/media/m1', key);
    expect(hit?.url).toBe(first.url);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('缓存键忽略凭证查询参数但区分作用域', async () => {
    const fetchMock = stubMedia();
    await acquireAuthenticatedMedia('/api/media/m1?token=user-secret', opts);
    await acquireAuthenticatedMedia('/api/media/m1', opts);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await acquireAuthenticatedMedia('/api/media/m1', { ...opts, scope: 'admin' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('超出条目上限时淘汰最久未用的空闲项，正在显示的不动', async () => {
    stubMedia();
    const pinned = await acquireAuthenticatedMedia('/api/media/pinned', opts);
    for (let i = 0; i < MEDIA_CACHE_MAX_ENTRIES + 5; i += 1) {
      await acquireAuthenticatedMedia(`/api/media/m${i}`, opts);
      releaseCachedMedia(`/api/media/m${i}`, key);
    }
    expect(mediaCacheStats().entries).toBeLessThanOrEqual(MEDIA_CACHE_MAX_ENTRIES);
    // 仍被持有的那张必须还在，撤销它会让界面变成裂图。
    expect(takeCachedMedia('/api/media/pinned', key)?.url).toBe(pinned.url);
    expect(takeCachedMedia('/api/media/m0', key)).toBeNull();
  });

  it('清空缓存会撤销所有 URL，不把私有媒体留在内存里', async () => {
    stubMedia();
    await acquireAuthenticatedMedia('/api/media/m1', opts);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    clearMediaCache();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(mediaCacheStats()).toMatchObject({ entries: 0, bytes: 0 });
    expect(takeCachedMedia('/api/media/m1', key)).toBeNull();
  });

  it('媒体请求不再禁用 HTTP 缓存（服务端带 ETag 与 immutable）', async () => {
    const fetchMock = stubMedia();
    await acquireAuthenticatedMedia('/api/media/m1', opts);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.cache).not.toBe('no-store');
  });

  it('只清指定鉴权作用域，不撤销另一作用域的 URL', async () => {
    stubMedia();
    const user = await acquireAuthenticatedMedia('/api/media/shared', opts);
    const adminOptions = { ...opts, scope: 'admin' as const, token: 'admin-secret' };
    const admin = await acquireAuthenticatedMedia('/api/media/shared', adminOptions);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    clearMediaCache('user');

    expect(takeCachedMedia('/api/media/shared', key)).toBeNull();
    expect(takeCachedMedia('/api/media/shared', { scope: 'admin', expected: 'image' })?.url).toBe(admin.url);
    expect(revoke).toHaveBeenCalledWith(user.url);
    expect(revoke).not.toHaveBeenCalledWith(admin.url);
  });

  it('令牌切换后丢弃旧作用域的在途响应，新请求不与它合并', async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce(new Response(new Blob(['new-value'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockImplementation((source) =>
      source instanceof Blob && source.size === 3 ? 'blob:old-generation' : 'blob:new-generation');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const oldRequest = acquireAuthenticatedMedia('/api/media/race', opts);
    clearMediaCache('user');
    const newRequest = acquireAuthenticatedMedia('/api/media/race', { ...opts, token: 'new-secret' });
    resolveOld(new Response(new Blob(['old'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    }));

    await expect(oldRequest).rejects.toMatchObject({ code: 'stale_auth' });
    await expect(newRequest).resolves.toMatchObject({ url: 'blob:new-generation' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledWith('blob:old-generation');
    expect(takeCachedMedia('/api/media/race', key)?.url).toBe('blob:new-generation');
  });

  it.each([401, 403])('HTTP %i 清理请求所属作用域的缓存', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(['user'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response(new Blob(['admin'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } }))
      .mockResolvedValueOnce(new Response('', { status }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:user').mockReturnValueOnce('blob:admin');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await acquireAuthenticatedMedia('/api/media/user-cached', { scope: 'user', token: 'user-secret', expected: 'image' });
    await acquireAuthenticatedMedia('/api/media/admin-cached', { scope: 'admin', token: 'admin-secret', expected: 'image' });
    await expect(fetchAuthenticatedMedia('/api/media/denied', {
      scope: 'user', token: 'expired', expected: 'image'
    })).rejects.toMatchObject({ code: 'auth', status });

    expect(takeCachedMedia('/api/media/user-cached', { scope: 'user', expected: 'image' })).toBeNull();
    expect(takeCachedMedia('/api/media/admin-cached', { scope: 'admin', expected: 'image' })).not.toBeNull();
  });
});

