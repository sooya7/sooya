// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api.js', () => ({ getToken: () => 'tok' }));

import { buildStreamRequest, ChatStream } from './stream.js';

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

/**
 * A response body that hands out the given chunks one `read()` at a time.
 * After the last chunk it either ends the stream (`end: true`, which makes the
 * client treat the connection as dropped) or hangs forever, keeping the
 * connection "live" the way a real idle SSE stream does.
 */
function sseBody(chunks: string[], end = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (index < chunks.length) return { done: false, value: encoder.encode(chunks[index++]!) };
        return end ? { done: true } : new Promise<never>(() => {});
      },
      releaseLock: () => {}
    })
  } as unknown as ReadableStream<Uint8Array>;
}

function okResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, body } as unknown as Response;
}

interface Recorder {
  events: Array<{ type: string; data: Record<string, any> }>;
  states: string[];
  gaps: number[];
  stream: ChatStream;
}

/**
 * Streams created by recording(), so a failed assertion cannot leave one
 * reconnecting in the background and pollute the next test's fetch count.
 */
const activeStreams: ChatStream[] = [];

function recording(): Recorder {
  const events: Recorder['events'] = [];
  const states: string[] = [];
  const gaps: number[] = [];
  const stream = new ChatStream({
    onEvent: (type, data) => events.push({ type, data }),
    onStateChange: (state) => states.push(state),
    onGap: (seq) => gaps.push(seq)
  });
  activeStreams.push(stream);
  return { events, states, gaps, stream };
}

function stopAllStreams(): void {
  while (activeStreams.length > 0) activeStreams.pop()!.stop();
}

/** URLs passed to the stubbed fetch, in order. */
function fetchUrls(): string[] {
  return (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
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

describe('buildStreamRequest', () => {
  it('带上已收到的 lastEventId 与 Bearer 令牌，并禁用缓存', () => {
    const { url, init } = buildStreamRequest(42, 'tok');
    expect(url).toBe('/api/stream?lastEventId=42');
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
    expect(init.cache).toBe('no-store');
  });

  it('lastEventId 为 0 时不带查询串，无令牌时不带请求头', () => {
    const { url, init } = buildStreamRequest(0, null);
    expect(url).toBe('/api/stream');
    expect(init.headers).toBeUndefined();
    expect(init.cache).toBe('no-store');
  });
});

describe('ChatStream 帧解析', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopAllStreams();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('CRLF 换行要先归一化，否则整帧都识别不出来', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(sseBody([
      'event: system.notice\r\nid: 3\r\ndata: {"text":"你好"}\r\n\r\n'
    ]))));
    const { events, stream } = recording();

    stream.start();
    await flush();

    expect(events).toEqual([{ type: 'system.notice', data: { text: '你好' } }]);
    stream.stop();
  });

  it('多行 data 拼接后再解析，字段名前后的空格由 trimStart 吃掉', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(sseBody([
      // 无空格的字段名 + 被拆成两行的 JSON
      'event:system.notice\nid:5\ndata:{"text":"两行",\ndata: "kind":"info"}\n\n'
    ]))));
    const { events, stream } = recording();

    stream.start();
    await flush();

    expect(events).toEqual([{ type: 'system.notice', data: { text: '两行', kind: 'info' } }]);
    stream.stop();
  });

  it('被 chunk 边界切断的帧要等下一段到达后才分发', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(sseBody([
      'event: system.no',
      'tice\ndata: {"text":"切开的帧"}\n\n'
    ]))));
    const { events, stream } = recording();

    // 第一段只喂了半个帧：读到它时不能有任何分发
    stream.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([]);

    await flush();
    expect(events).toEqual([{ type: 'system.notice', data: { text: '切开的帧' } }]);
    stream.stop();
  });

  it('白名单外的事件类型与没有 data 行的帧都被丢弃', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(sseBody([
      'event: reply.telepathy\ndata: {"text":"没这个类型"}\n\n',
      'event: system.notice\nid: 8\n\n',
      'event: system.notice\ndata: {"text":"只有我该送达"}\n\n'
    ]))));
    const { events, stream } = recording();

    stream.start();
    await flush();

    expect(events).toEqual([{ type: 'system.notice', data: { text: '只有我该送达' } }]);
    stream.stop();
  });
});

describe('ChatStream 断线续传', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopAllStreams();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('id: 与 data.seq 都推进 lastEventId（只增不减），重连时带上最大值', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(sseBody([
      'event: system.notice\nid: 5\ndata: {"text":"a"}\n\n',
      'event: system.notice\ndata: {"seq":9,"text":"b"}\n\n',
      // 回退的 id 与非数字 id 都不能覆盖已推进的值
      'event: system.notice\nid: 3\ndata: {"text":"c"}\n\n',
      'event: system.notice\nid: abc\ndata: {"text":"d"}\n\n'
    ], true))));
    const { events, states, stream } = recording();

    stream.start();
    await flush();
    expect(events).toHaveLength(4);
    // 流被服务端结束 → 视为掉线并排重连
    expect(states).toContain('offline');

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchUrls()).toEqual(['/api/stream', '/api/stream?lastEventId=9']);
    stream.stop();
  });

  it('stream.ready 只改连接状态：gapPossible 时补齐、lastEventSeq 写入续传位置', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(sseBody([
      'event: stream.ready\ndata: {"gapPossible":true,"lastMessageSeq":17,"lastEventSeq":21}\n\n'
    ], true))));
    const { events, states, gaps, stream } = recording();

    stream.start();
    await flush();

    expect(gaps).toEqual([17]);
    expect(events).toEqual([]); // stream.ready 不进 onEvent
    expect(states.slice(0, 3)).toEqual(['connecting', 'online', 'online']);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchUrls()[1]).toBe('/api/stream?lastEventId=21');
    stream.stop();
  });

  it('stream.ready 的 gapPossible 为假时不要求 REST 补齐', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(sseBody([
      'event: stream.ready\ndata: {"gapPossible":false,"lastMessageSeq":17}\n\n'
    ]))));
    const { events, gaps, stream } = recording();

    stream.start();
    await flush();

    expect(gaps).toEqual([]);
    expect(events).toEqual([]);
    stream.stop();
  });
});

describe('ChatStream 连接状态与退避', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stopAllStreams();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const status of [401, 403]) {
    it(`${status} 视为鉴权失败：不重连，等用户换令牌`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, body: null }) as unknown as Response));
      const { states, stream } = recording();

      stream.start();
      await flush();
      expect(states).toEqual(['connecting', 'unauthorized']);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      stream.stop();
    });
  }

  it('连续失败时退避 1s→2s→4s→8s→15s 并在 15s 封顶', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // 去掉 jitter，延迟可精确断言
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { stream } = recording();

    stream.start();
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    const delays = [1000, 2000, 4000, 8000, 15_000, 15_000];
    for (const [index, delay] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetch).toHaveBeenCalledTimes(index + 1); // 差 1ms 还不能重连
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(index + 2);
    }

    stream.stop();
  });

  it('成功连上一次后退避计数归零，下次掉线重新从 1s 起', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempt = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempt += 1;
      // 前两次失败（退避涨到 2s），第三次连上后被服务端结束，第四次起继续失败
      if (attempt === 3) return okResponse(sseBody([], true));
      throw new Error('network down');
    }));
    const { stream } = recording();

    stream.start();
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(3); // 这次连上了

    // 归零后应当是 1s，而不是继续按 4s 退避
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(4);

    stream.stop();
  });

  it('stop() 中止在途请求、清掉重连计时器并摘掉 online / visibilitychange 监听', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return deferred<Response>().promise; // 永不落定：连接一直在途
    }));
    const { stream } = recording();

    stream.start();
    await flush();
    expect(signals[0]!.aborted).toBe(false);

    stream.stop();
    expect(signals[0]!.aborted).toBe(true);

    window.dispatchEvent(new Event('online'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
