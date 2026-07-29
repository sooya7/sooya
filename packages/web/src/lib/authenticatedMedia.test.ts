import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blobForMediaUrl, fetchAuthenticatedMedia, releaseMediaUrl } from './authenticatedMedia.js';
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
    expect(source).toContain("const VERSION = 'sooya-v6'");
    expect(source).toContain("keys.filter((key) => !key.startsWith(VERSION))");
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
