// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthenticatedMedia } from './useAuthenticatedMedia.js';
import { clearMediaCache } from './authenticatedMedia.js';

/**
 * Response bodies are bytes, never a `Blob`.
 *
 * `Response` here is Node's (undici) while `Blob` is jsdom's, and undici builds
 * a body by calling `.stream()` on what it is handed — which jsdom's Blob does
 * not implement, so `new Response(new Blob([...]))` throws
 * `TypeError: object.stream is not a function`. In the first test that surfaced
 * directly; in the second it was swallowed, because a throwing fetch is
 * classified `network`, which is retriable, so the hook sat in its 400ms backoff
 * while the assertion looked at an img that had no src yet.
 */
const bytes = (seed: string) => new TextEncoder().encode(seed);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function Probe({ path }: { path: string }) {
  const media = useAuthenticatedMedia(path, 'user', 'image');
  return <img data-testid="media" src={media.url ?? undefined} alt="" />;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  // 缓存是模块级的，会跨用例存活；不清就会互相污染。
  clearMediaCache();
});

describe('useAuthenticatedMedia lifecycle', () => {
  /*
   * 撤销时机是刻意改过的：以前卸载就 revokeObjectURL，于是切标签页回来、画廊往回滚一屏，
   * 同一批图整批重传。现在卸载只放开引用，字节留在共享缓存里等淘汰。
   */
  function urlMocks() {
    let n = 0;
    const create = vi.fn(() => `blob:${++n}`);
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    return { create, revoke };
  }

  it('只显示最新一次请求的结果，迟到的旧响应不会顶掉它', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('sooya.token', 'chat-secret');
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/old') ? oldResponse.promise : newResponse.promise));
    const { revoke } = urlMocks();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Probe path="/api/media/old" />); });
    await act(async () => { root.render(<Probe path="/api/media/new" />); });

    await act(async () => {
      newResponse.resolve(new Response(bytes('new'), { status: 200, headers: { 'content-type': 'image/png' } }));
      await newResponse.promise;
    });
    const shown = container.querySelector('img')?.src;
    expect(shown).toBe('blob:1');

    await act(async () => {
      oldResponse.resolve(new Response(bytes('old'), { status: 200, headers: { 'content-type': 'image/png' } }));
      await oldResponse.promise;
    });
    // 旧路径的字节已经付过网络代价了，进缓存备用，但不能改变当前显示的图。
    expect(container.querySelector('img')?.src).toBe(shown);
    expect(revoke).not.toHaveBeenCalled();

    await act(async () => { root.unmount(); });
    expect(revoke).not.toHaveBeenCalled();
    container.remove();
  });

  it('换路径与卸载都不撤销 URL，回到旧路径直接命中缓存不再请求', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('sooya.token', 'chat-secret');
    const fetchMock = vi.fn(async (url: string) => new Response(
      bytes(url),
      { status: 200, headers: { 'content-type': 'image/png' } }
    ));
    vi.stubGlobal('fetch', fetchMock);
    const { revoke } = urlMocks();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe path="/api/media/old" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('img')?.src).toBe('blob:1');

    await act(async () => {
      root.render(<Probe path="/api/media/new" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('img')?.src).toBe('blob:2');
    expect(revoke).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 回到旧路径：同步就有 URL，不闪空白、不再发请求。
    act(() => { root.render(<Probe path="/api/media/old" />); });
    expect(container.querySelector('img')?.src).toBe('blob:1');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => { root.unmount(); });
    expect(revoke).not.toHaveBeenCalled();

    // 清空是唯一会撤销的时机（退出登录/换令牌）。
    clearMediaCache();
    expect(revoke).toHaveBeenCalledTimes(2);
    container.remove();
  });
});
