import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPushApi } from './pushApi.js';
import { createVisibilitySynchronizer } from './visibilitySync.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('push visibility synchronization', () => {
  it('retries transient failures a finite number of times', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => { throw new Error('temporary network failure'); });
    const sync = createVisibilitySynchronizer(send, () => true);

    sync.notify();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenNthCalledWith(1, true);
    expect(send).toHaveBeenNthCalledWith(3, true);
    sync.dispose();
  });

  it('tries again on the next state change after retries are exhausted', async () => {
    vi.useFakeTimers();
    let visible = true;
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockRejectedValueOnce(new Error('three'))
      .mockResolvedValue(undefined);
    const sync = createVisibilitySynchronizer(send, () => visible);

    sync.notify();
    await vi.advanceTimersByTimeAsync(5_000);
    visible = false;
    sync.notify();
    await vi.runAllTimersAsync();

    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith(false);
    sync.dispose();
  });

  it('cancels stale retries and synchronizes the newest state immediately', async () => {
    vi.useFakeTimers();
    let visible = true;
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('visible failed'))
      .mockResolvedValue(undefined);
    const sync = createVisibilitySynchronizer(send, () => visible);

    sync.notify();
    await vi.advanceTimersByTimeAsync(1);
    visible = false;
    sync.notify();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(send.mock.calls).toEqual([[true], [false]]);
    sync.dispose();
  });

  it('stops pending retries after disposal', async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => { throw new Error('offline'); });
    const sync = createVisibilitySynchronizer(send, () => true);

    sync.notify();
    await vi.advanceTimersByTimeAsync(1);
    sync.dispose();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('re-reads authentication when retrying an unauthorized request', async () => {
    vi.useFakeTimers();
    let token = 'expired-token';
    vi.stubGlobal('localStorage', { getItem: () => token });
    const requests = vi.fn(async (_path: string, init: RequestInit) => {
      const credential = new Headers(init.headers).get('x-sooya-token');
      if (credential === 'expired-token') {
        token = 'refreshed-token';
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', requests);
    const sync = createVisibilitySynchronizer(
      (visible) => requestPushApi('/api/push/visibility', {
        method: 'POST',
        body: JSON.stringify({ endpoint: 'https://push.example/sub', visible })
      }),
      () => true
    );

    sync.notify();
    await vi.advanceTimersByTimeAsync(250);

    expect(requests).toHaveBeenCalledTimes(2);
    expect(new Headers(requests.mock.calls[0]![1].headers).get('x-sooya-token')).toBe('expired-token');
    expect(new Headers(requests.mock.calls[1]![1].headers).get('x-sooya-token')).toBe('refreshed-token');
    sync.dispose();
  });
});
