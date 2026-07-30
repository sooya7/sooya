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
  MEDIA_RETRY_DELAYS_MS
} from './authenticatedMedia.js';
import { mediaUrl } from './api.js';
import { adminMediaUrl } from './features.js';
import { buildStreamRequest } from './stream.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('authenticated media', () => {
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
    [401, 'auth'],
    [403, 'auth'],
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
