// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChat } from './useChat.js';
import type { BootstrapInfo } from './api.js';
import type { ChatMessage } from './types.js';

/**
 * `useChat` 的第一片：首屏挂载与 `send()`。
 *
 * 这个 hook 一挂载就会 `api.bootstrap()` 并开一条真实的 `ChatStream`，所以桩 `fetch`
 * 必须按路由分派：`/api/bootstrap`、`/api/stream`（一条永不结束的 SSE，模拟空闲长连接）
 * 和 `POST /api/messages`。SSE 不能用真的 `Response`——`ChatStream` 只读 `.body`，
 * 手写一个 `read()` 永远挂住的 reader 才不会让连接被判成断开而进重连退避。
 *
 * 挂载出来的 root 一律登记到 `roots`，在 `afterEach` 里统一卸载：卸载会 `stream.stop()`，
 * 断言失败时若漏了这一步，后台的重连会污染下一个用例的 fetch 计数。
 */
type Chat = ReturnType<typeof useChat>;

interface Call {
  url: string;
  method: string | undefined;
  body: string | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 空闲 SSE：握手成功（`online`），之后永远不产出数据也不结束。 */
function idleStream(): Response {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => new Promise<never>(() => {}),
        releaseLock: () => {}
      })
    }
  } as unknown as Response;
}

function part(over: Partial<ChatMessage['content'][number]> = {}): ChatMessage['content'][number] {
  return { id: 'p_1', type: 'text', text: '嗨', status: 'sent', ...over };
}

function message(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm_1',
    conversationId: 'main',
    role: 'assistant',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    seq: 1,
    status: 'sent',
    content: [part()],
    ...over
  };
}

function bootstrapInfo(over: Partial<BootstrapInfo> = {}): BootstrapInfo {
  return {
    conversation: {
      conversationId: 'main',
      persona: { name: 'SOOYA', avatar: '/avatars/sooya.svg', userAvatar: '/avatars/user.svg', tagline: '在的' },
      messageCount: 1,
      lastSeq: 7,
      lastEventSeq: 42
    },
    messages: { messages: [message({ id: 'm_7', seq: 7 })], hasMore: true, lastEventSeq: 42, lastMessageSeq: 7, oldestSeq: 7 },
    stickers: [{ id: 's_1', name: '笑', emotion: 'happy', tags: ['笑'], url: '/api/media/s_1', mediaId: 'md_1' }],
    life: { activity: '在看书', kind: 'rest', mood: '平静', startedAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-08-01T01:00:00.000Z', recent: [] },
    ...over
  };
}

const calls: Call[] = [];
const roots: Array<{ root: Root; container: HTMLElement }> = [];

interface Routes {
  bootstrap?: () => Response;
  send?: () => Response | Promise<Response>;
}

/** 手动决定何时应答，用来观察请求挂起期间的中间状态。 */
function deferredResponse() {
  let settle!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => { settle = resolve; });
  return { promise, settle };
}

/** 按路由分派的桩 `fetch`，顺带记录每次请求。 */
function stubRoutes(routes: Routes = {}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method, body: typeof init.body === 'string' ? init.body : null });
    if (url.startsWith('/api/bootstrap')) return routes.bootstrap ? routes.bootstrap() : json(bootstrapInfo());
    if (url.startsWith('/api/stream')) return idleStream();
    if (url.startsWith('/api/messages')) {
      if (!routes.send) throw new Error('用例没有配置 /api/messages 的应答');
      return routes.send();
    }
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function sendCall(): { clientMsgId: string; content: Array<Record<string, unknown>>; replyTo?: string } {
  const post = calls.find((call) => call.url === '/api/messages' && call.method === 'POST');
  return JSON.parse(post!.body!) as { clientMsgId: string; content: Array<Record<string, unknown>>; replyTo?: string };
}

function streamUrls(): string[] {
  return calls.filter((call) => call.url.startsWith('/api/stream')).map((call) => call.url);
}

/** 挂载 hook，返回读取最新一次渲染结果的取值器。 */
async function mountChat(): Promise<() => Chat> {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let latest: Chat | null = null;
  function Probe() {
    latest = useChat();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(<Probe />);
    // bootstrap 与 SSE 握手都是异步的，让它们跑完再断言。
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return () => latest!;
}

afterEach(async () => {
  // 先卸载（会 stop() 掉长连接），再拆桩。
  for (const { root, container } of roots.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  calls.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('useChat 首屏挂载', () => {
  it('bootstrap 的载荷全部落到状态里，并按 lastEventSeq 起流', async () => {
    stubRoutes();
    const chat = await mountChat();

    expect(chat().ready).toBe(true);
    expect(chat().error).toBeNull();
    expect(chat().persona?.tagline).toBe('在的');
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7']);
    expect(chat().hasMore).toBe(true);
    expect(chat().stickers.map((s) => s.id)).toEqual(['s_1']);
    expect(chat().life?.activity).toBe('在看书');
    // 握手成功即 online；断点续传要从 bootstrap 给的 lastEventSeq 接上，
    // 否则重连会把已经读过的事件整批重放。
    expect(chat().connection).toBe('online');
    expect(streamUrls()).toEqual(['/api/stream?lastEventId=42']);
  });

  it('bootstrap 401 时置为未授权，且不开 SSE 连接', async () => {
    stubRoutes({ bootstrap: () => json({ error: 'unauthorized' }, 401) });
    const chat = await mountChat();

    expect(chat().connection).toBe('unauthorized');
    // 首屏没过鉴权还去连流只会再吃一个 401，白费一次请求。
    expect(streamUrls()).toEqual([]);
    // 未授权也必须结束 loading，否则界面卡在骨架屏上，连令牌都没法输。
    expect(chat().ready).toBe(true);
    expect(chat().error).toBeNull();
  });

  it('bootstrap 其他错误时离线并暴露服务端错误文案', async () => {
    stubRoutes({ bootstrap: () => json({ message: '数据库开不了' }, 500) });
    const chat = await mountChat();

    expect(chat().connection).toBe('offline');
    expect(chat().error).toBe('数据库开不了');
    expect(chat().ready).toBe(true);
    expect(streamUrls()).toEqual([]);
  });
});

describe('useChat send()', () => {
  it('先插乐观消息，服务端确认后换成真消息', async () => {
    // POST 挂住不应答，才能看清「已上屏但未确认」这一段。
    const post = deferredResponse();
    stubRoutes({ send: () => post.promise });
    const chat = await mountChat();

    let sent!: Promise<unknown>;
    // 乐观条目必须在 await 之前就出现在列表里，用户松手就能看到自己发的话。
    await act(async () => {
      sent = chat().send([{ type: 'text', text: '在吗' }], undefined, 'm_7');
    });

    const optimistic = chat().messages.find((m) => m.pendingLocal);
    expect(optimistic).toBeDefined();
    expect(optimistic!.role).toBe('user');
    expect(optimistic!.status).toBe('pending');
    expect(optimistic!.replyTo).toBe('m_7');
    expect(optimistic!.content.map((p) => [p.type, p.text])).toEqual([['text', '在吗']]);
    // 排在最后：乐观条目的 seq 必须压过任何真实消息。
    expect(chat().messages.at(-1)!.id).toBe(optimistic!.id);

    const payload = sendCall();
    expect(payload.content).toEqual([{ type: 'text', text: '在吗' }]);
    expect(payload.replyTo).toBe('m_7');
    // 幂等键：服务端靠它给重试去重，必须和乐观条目上的是同一个。
    expect(payload.clientMsgId).toBe(optimistic!.clientMsgId);

    let result: { message: ChatMessage; duplicate: boolean } | undefined;
    await act(async () => {
      post.settle(json({ message: message({ id: 'm_8', seq: 8, role: 'user', clientMsgId: payload.clientMsgId }), duplicate: false, replyPending: true }));
      result = (await sent) as { message: ChatMessage; duplicate: boolean };
    });

    expect(result!.message.id).toBe('m_8');
    // 乐观条目换成真消息，不能两条并存（重复气泡）。
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8']);
    expect(chat().messages.some((m) => m.pendingLocal)).toBe(false);
    expect(chat().error).toBeNull();
  });

  it('发送失败时乐观消息标记失败并保留，错误抛给调用方', async () => {
    stubRoutes({ send: () => json({ message: '上游炸了' }, 500) });
    const chat = await mountChat();

    let failure: unknown;
    await act(async () => {
      failure = await chat().send([{ type: 'text', text: '在吗' }]).catch((err: unknown) => err);
    });

    expect((failure as Error).message).toBe('上游炸了');
    // 失败的消息要留在列表里，用户才能重试；丢掉就等于内容凭空消失。
    const failed = chat().messages.find((m) => m.pendingLocal);
    expect(failed).toBeDefined();
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('上游炸了');
    expect(chat().error).toBe('上游炸了');
    // 只是上游错误，不能顺手把连接判成未授权。
    expect(chat().connection).toBe('online');
  });

  it('发送遇到 401 时同时置为未授权', async () => {
    stubRoutes({ send: () => json({ error: 'unauthorized' }, 401) });
    const chat = await mountChat();

    await act(async () => { await chat().send([{ type: 'text', text: '在吗' }]).catch(() => {}); });

    expect(chat().connection).toBe('unauthorized');
    expect(chat().error).toBe('unauthorized');
    expect(chat().messages.find((m) => m.pendingLocal)!.status).toBe('failed');
  });
});
