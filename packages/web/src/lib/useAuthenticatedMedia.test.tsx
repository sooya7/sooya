// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthenticatedMedia } from './useAuthenticatedMedia.js';

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
});

describe('useAuthenticatedMedia lifecycle', () => {
  it('keeps the newest request and creates no Object URL for an aborted stale response', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('sooya.token', 'chat-secret');
    const oldResponse = deferred<Response>();
    const newResponse = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/old') ? oldResponse.promise : newResponse.promise));
    const create = vi.fn().mockReturnValueOnce('blob:new');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<Probe path="/api/media/old" />); });
    await act(async () => { root.render(<Probe path="/api/media/new" />); });

    await act(async () => {
      newResponse.resolve(new Response(new Blob(['new'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      }));
      await newResponse.promise;
    });
    expect(container.querySelector('img')?.src).toBe('blob:new');

    await act(async () => {
      oldResponse.resolve(new Response(new Blob(['old'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      }));
      await oldResponse.promise;
    });
    expect(container.querySelector('img')?.src).toBe('blob:new');
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();

    await act(async () => { root.unmount(); });
    expect(revoke).toHaveBeenCalledWith('blob:new');
    expect(revoke).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it('revokes the previous URL on replacement and the current URL on unmount', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('sooya.token', 'chat-secret');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      new Blob([url], { type: 'image/png' }),
      { status: 200, headers: { 'content-type': 'image/png' } }
    )));
    const create = vi.fn()
      .mockReturnValueOnce('blob:old')
      .mockReturnValueOnce('blob:new');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Probe path="/api/media/old" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('img')?.src).toBe('blob:old');

    await act(async () => {
      root.render(<Probe path="/api/media/new" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(revoke).toHaveBeenCalledWith('blob:old');
    expect(container.querySelector('img')?.src).toBe('blob:new');

    await act(async () => { root.unmount(); });
    expect(revoke).toHaveBeenCalledWith('blob:new');
    expect(revoke).toHaveBeenCalledTimes(2);
    container.remove();
  });
});
