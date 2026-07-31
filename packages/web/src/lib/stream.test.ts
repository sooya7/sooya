// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', () => ({ getToken: () => 'tok' }));

import { ChatStream } from './stream.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Drain pending promise chains without touching the (fake) clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('ChatStream 重连', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * 连接失败后排好重连计时器，此刻浏览器触发 online（或切回前台）会立即再连一次 ——
   * 但旧计时器没被废掉，到点又连第三次：两个并发的 SSE 连接同时活着，而且先开的那个
   * controller 被覆盖，stop() 再也关不掉它。
   */
  it('online 事件触发立即重连时，挂起的重连计时器必须作废', async () => {
    const calls: Array<ReturnType<typeof deferred<Response>>> = [];
    vi.stubGlobal('fetch', vi.fn(() => {
      const pending = deferred<Response>();
      calls.push(pending);
      return pending.promise;
    }));
    const states: string[] = [];
    const stream = new ChatStream({ onEvent: () => {}, onStateChange: (state) => states.push(state), onGap: () => {} });

    stream.start();
    expect(fetch).toHaveBeenCalledTimes(1);

    // 第一次连接失败 → 安排重连计时器（1s + jitter）
    calls[0]!.reject(new Error('network down'));
    await flush();
    expect(states).toContain('offline');

    // 浏览器报告网络恢复 → 立即重连
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);

    // 越过原重连计时器的触发点：不得再开第三个连接
    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);

    stream.stop();
  });

  /**
   * useChat 的 onEvent 处理 persona.updated 与 life.updated，但事件解析层的类型
   * 白名单是从 EventSource 时代继承的，没有这两个类型 —— 帧在 dispatch 之前就被
   * 丢弃：管理面板改完人设聊天页头顶不更新，她换了活动生活面板也不动。
   */
  it('useChat 已处理的 persona.updated / life.updated 必须送达 onEvent', async () => {
    const encoder = new TextEncoder();
    const frames = [
      'id: 11\nevent: life.updated\ndata: {"activity":"看书","kind":"hobby"}\n\n',
      'id: 12\nevent: persona.updated\ndata: {"persona":{"name":"SOOYA"}}\n\n'
    ].map((frame) => encoder.encode(frame));
    let index = 0;
    const body = {
      getReader: () => ({
        read: async (): Promise<{ done: boolean; value?: Uint8Array }> =>
          index < frames.length ? { done: false, value: frames[index++]! } : new Promise(() => {}),
        releaseLock: () => {}
      })
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body }) as unknown as Response));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const stream = new ChatStream({ onEvent: (type, data) => events.push({ type, data }), onStateChange: () => {}, onGap: () => {} });

    stream.start();
    await flush();

    expect(events.map((event) => event.type)).toEqual(['life.updated', 'persona.updated']);
    expect(events[0]!.data).toMatchObject({ activity: '看书' });
    expect(events[1]!.data).toMatchObject({ persona: { name: 'SOOYA' } });

    stream.stop();
  });

  it('切回前台撞上挂起的重连计时器时同样不重复连接', async () => {
    const calls: Array<ReturnType<typeof deferred<Response>>> = [];
    vi.stubGlobal('fetch', vi.fn(() => {
      const pending = deferred<Response>();
      calls.push(pending);
      return pending.promise;
    }));
    const stream = new ChatStream({ onEvent: () => {}, onStateChange: () => {}, onGap: () => {} });

    stream.start();
    calls[0]!.reject(new Error('network down'));
    await flush();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(2);

    stream.stop();
  });
});
