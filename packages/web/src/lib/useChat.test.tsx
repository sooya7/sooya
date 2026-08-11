// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReplayableUserMessage, isRetryableFailedMessage, useChat } from './useChat.js';
import type { BootstrapInfo } from './api.js';
import type { ChatMessage } from './types.js';

/**
 * `useChat` 的三片覆盖：首屏挂载与 `send()`；SSE 事件分派与流式草稿；
 * `resync()` 翻页、`loadOlder()`、`resend()`、`withdraw()` 与回前台重同步。
 *
 * 这个 hook 一挂载就会 `api.bootstrap()` 并开一条真实的 `ChatStream`，所以桩 `fetch`
 * 必须按路由分派：`/api/bootstrap`、`/api/stream`（一条永不结束的 SSE，模拟空闲长连接）
 * 和 `POST /api/messages`。SSE 不能用真的 `Response`——`ChatStream` 只读 `.body`，
 * 手写一个 `read()` 永远挂住的 reader 才不会让连接被判成断开而进重连退避。
 *
 * 挂载出来的 root 一律登记到 `roots`，在 `afterEach` 里统一卸载：卸载会 `stream.stop()`，
 * 断言失败时若漏了这一步，后台的重连会污染下一个用例的 fetch 计数。
 *
 * 第二片把空闲 SSE 换成 `pushableStream()`：同样只给 `.body`，但 `push()` 能在挂载之后
 * 逐帧喂 `event:` / `id:` / `data:`，帧与帧之间连接依旧挂住，于是能一帧一帧地断言。
 */
type Chat = ReturnType<typeof useChat>;

describe('消息重放边界', () => {
  it('只允许有内容且不含历史音频的用户消息', () => {
    expect(isReplayableUserMessage(message({ id: 'u1', role: 'user' }))).toBe(true);
    expect(isRetryableFailedMessage(message({ id: 'u1', role: 'user', status: 'failed' }))).toBe(false);
    expect(isRetryableFailedMessage(message({ id: 'u1', role: 'user', status: 'failed', clientMsgId: 'c1' }))).toBe(true);
    expect(isReplayableUserMessage(message({ id: 'a1', role: 'assistant', status: 'failed' }))).toBe(false);
    expect(isReplayableUserMessage(message({
      id: 'u2', role: 'user', status: 'failed',
      content: [{ id: 'audio', type: 'audio', mediaId: 'md_audio', status: 'sent' }]
    }))).toBe(false);
  });
});

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

type Chunk = { done: boolean; value?: Uint8Array };

/**
 * 可逐帧推送的 SSE：`push()` 写一帧并把 React 的更新冲干，之后连接继续挂住。
 * 队列空时 `read()` 必须挂起而不是返回 `done`——返回 `done` 会被 `ChatStream`
 * 判成断线并进重连退避，后面的帧就没人读了。
 */
function pushableStream(): { response: Response; push: (type: string, data: Record<string, unknown>, id?: number) => Promise<void> } {
  const encoder = new TextEncoder();
  const queued: Uint8Array[] = [];
  let waiting: ((chunk: Chunk) => void) | null = null;
  const response = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: (): Promise<Chunk> => {
          const next = queued.shift();
          if (next) return Promise.resolve({ done: false, value: next });
          return new Promise<Chunk>((resolve) => { waiting = resolve; });
        },
        releaseLock: () => {}
      })
    }
  } as unknown as Response;

  const push = async (type: string, data: Record<string, unknown>, id?: number) => {
    const frame = `event: ${type}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
    const value = encoder.encode(frame);
    await act(async () => {
      if (waiting) { const resolve = waiting; waiting = null; resolve({ done: false, value }); }
      else queued.push(value);
      // 事件处理里可能再发请求（resync / reload / life），一起等它们跑完。
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  return { response, push };
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
    presence: { city: null, location: null, travel: null, weather: null, updatedAt: '2026-08-01T00:00:00.000Z' },
    ...over
  };
}

const calls: Call[] = [];
const roots: Array<{ root: Root; container: HTMLElement }> = [];

interface Routes {
  bootstrap?: () => Response;
  send?: () => Response | Promise<Response>;
  /** `GET /api/messages`：`resync()` 的增量与 `loadOlder()` 的翻页都走这里。 */
  messages?: (url: string) => Response | Promise<Response>;
  /** `GET /api/messages/<id>/context`：引用目标懒加载的窗口。 */
  messageContext?: (url: string) => Response | Promise<Response>;
  /** `POST /api/messages/<id>/withdraw`：必须比 `send` 先匹配，否则会被 POST 分支吃掉。 */
  withdraw?: (url: string) => Response;
  life?: () => Response;
  /** 默认空闲 SSE；第二片用 `pushableStream()` 换成可推送的连接。 */
  stream?: () => Response;
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
    if (url.startsWith('/api/stream')) return routes.stream ? routes.stream() : idleStream();
    if (url.startsWith('/api/messages')) {
      // 撤回也是 POST /api/messages…，先按路径尾判掉，否则会落到 send 的应答上。
      if (url.endsWith('/withdraw')) {
        if (!routes.withdraw) throw new Error('用例没有配置 POST /api/messages/<id>/withdraw 的应答');
        return routes.withdraw(url);
      }
      if (url.includes('/context?')) {
        if (!routes.messageContext) throw new Error('用例没有配置引用消息上下文应答');
        return routes.messageContext(url);
      }
      if (init.method === 'POST') {
        if (!routes.send) throw new Error('用例没有配置 POST /api/messages 的应答');
        return routes.send();
      }
      if (!routes.messages) throw new Error('用例没有配置 GET /api/messages 的应答');
      return routes.messages(url);
    }
    if (url.startsWith('/api/life')) {
      if (!routes.life) throw new Error('用例没有配置 /api/life 的应答');
      return routes.life();
    }
    throw new Error(`未预期的请求：${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

interface SendPayload { clientMsgId: string; content: Array<Record<string, unknown>>; replyTo?: string }

/** 所有 `POST /api/messages` 的载荷，按发出顺序；重试要靠它比对幂等键。 */
function sendCalls(): SendPayload[] {
  return calls.filter((call) => call.url === '/api/messages' && call.method === 'POST').map((call) => JSON.parse(call.body!) as SendPayload);
}

function sendCall(): SendPayload {
  return sendCalls()[0]!;
}

function streamUrls(): string[] {
  return calls.filter((call) => call.url.startsWith('/api/stream')).map((call) => call.url);
}

/** `GET /api/messages` 的请求串，用来断言 `resync()` 到底按什么游标拉的。 */
function messageQueries(): string[] {
  return calls.filter((call) => call.url.startsWith('/api/messages?')).map((call) => call.url);
}

function countCalls(prefix: string): number {
  return calls.filter((call) => call.url.startsWith(prefix)).length;
}

/** `GET /api/messages` 的一页应答，字段按 `api.messages` 的契约来。 */
function messagePage(messages: ChatMessage[], over: { hasMore?: boolean; nextSince?: number } = {}): Response {
  return json({
    messages,
    hasMore: over.hasMore ?? false,
    nextSince: over.nextSince,
    lastEventSeq: 50,
    lastMessageSeq: messages.at(-1)?.seq ?? 7,
    oldestSeq: messages[0]?.seq ?? null
  });
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

/** 挂载 hook，并把 SSE 换成可逐帧推送的连接。 */
async function mountStreaming(routes: Routes = {}): Promise<{ chat: () => Chat; push: (type: string, data: Record<string, unknown>, id?: number) => Promise<void> }> {
  const sse = pushableStream();
  stubRoutes({ ...routes, stream: () => sse.response });
  const chat = await mountChat();
  // 帧只有在连接真的握上之后才有人读，先把这个前提钉住。
  expect(chat().connection).toBe('online');
  return { chat, push: sse.push };
}

/** 卸载所有挂载出来的 root（会 `stream.stop()` 并摘掉可见性监听）。 */
async function unmountAll(): Promise<void> {
  for (const { root, container } of roots.splice(0)) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
}

/** 派发一个事件并把它引发的请求与重渲染都冲干。 */
async function dispatch(target: EventTarget, type: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new Event(type));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  // 先卸载（会 stop() 掉长连接），再拆桩。
  await unmountAll();
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

describe('useChat SSE 活动状态', () => {
  it('各类回复进度事件映射到对应的活动文案', async () => {
    const { chat, push } = await mountStreaming();
    expect(chat().activity).toEqual({ thinking: false, label: null });

    const stages: Array<[string, Record<string, unknown>, string]> = [
      ['reply.thinking', {}, '正在思考'],
      ['reply.text.delta', { messageId: 'm_9', delta: '在' }, '正在输入'],
      ['reply.sticker.selecting', {}, '正在挑表情'],
      ['reply.image.generating', {}, '正在生成图片'],
      ['reply.audio.generating', {}, '正在生成语音'],
      ['reply.text.done', {}, '正在整理'],
      ['reply.content.done', {}, '正在整理']
    ];
    for (const [type, data, label] of stages) {
      await push(type, data);
      // 整个生成过程里 thinking 必须一直是 true：头部的「正在…」提示靠它显示。
      expect(chat().activity, type).toEqual({ thinking: true, label });
    }
  });
});

describe('useChat 流式草稿', () => {
  it('delta 只累积独立草稿，正式消息数组保持同一引用', async () => {
    const { chat, push } = await mountStreaming();
    const finalizedBeforeDelta = chat().messages;

    await push('reply.text.delta', { messageId: 'm_9', delta: '你' });
    expect(chat().messages).toBe(finalizedBeforeDelta);
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7']);
    expect(chat().streamingDraft).toMatchObject({ id: 'm_9', text: '你' });
    expect(chat().streamingDraft?.createdAt).toEqual(expect.any(String));

    const createdAt = chat().streamingDraft!.createdAt;
    await push('reply.text.delta', { messageId: 'm_9', delta: '好呀' });

    expect(chat().messages).toBe(finalizedBeforeDelta);
    expect(chat().streamingDraft).toEqual({ id: 'm_9', text: '你好呀', createdAt });
  });

  it('reply.completed 带正式消息时只合并一次并清掉对应草稿', async () => {
    const { chat, push } = await mountStreaming();
    await push('reply.text.delta', { messageId: 'm_9', delta: '你' });
    await push('reply.completed', {
      message: message({ id: 'm_9', seq: 9, content: [part({ id: 'p_9', text: '你好呀' })] })
    });

    expect(chat().streamingDraft).toBeNull();
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_9']);
    expect(chat().messages.at(-1)).toMatchObject({ id: 'm_9', seq: 9, status: 'sent' });
    expect(chat().messages.at(-1)!.content.map((p) => [p.id, p.text])).toEqual([['p_9', '你好呀']]);
    expect(chat().activity).toEqual({ thinking: false, label: null });
  });

  it('普通 resync 不误删草稿；同 id 正式消息到达时才收敛', async () => {
    let page = 0;
    const { chat, push } = await mountStreaming({
      messages: () => {
        page += 1;
        return page === 1
          ? messagePage([message({ id: 'm_8', seq: 8 })])
          : messagePage([message({ id: 'm_9', seq: 9, content: [part({ id: 'p_9', text: '完成文本' })] })]);
      }
    });

    await push('reply.text.delta', { messageId: 'm_9', delta: '草稿' });
    await act(async () => { await chat().resync(); });
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8']);
    expect(chat().streamingDraft?.id).toBe('m_9');

    await act(async () => { await chat().resync(); });
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8', 'm_9']);
    expect(chat().streamingDraft).toBeNull();
  });

  it('reply.completed 不带 message 时拉增量，并由同 id 正式消息清草稿', async () => {
    const { chat, push } = await mountStreaming({
      messages: () => messagePage([
        message({ id: 'm_7', seq: 7 }),
        message({ id: 'm_9', seq: 9, content: [part({ id: 'p_9', text: '服务端完成文本' })] })
      ])
    });
    await push('reply.text.delta', { messageId: 'm_9', delta: '临时文本' });
    await push('reply.completed', {});

    expect(messageQueries()).toEqual(['/api/messages?limit=100&since=7']);
    expect(chat().streamingDraft).toBeNull();
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_9']);
    expect(chat().messages.at(-1)!.content[0]?.text).toBe('服务端完成文本');
  });

  it('reply.failed 与完整 reload 都无条件清掉草稿', async () => {
    let boots = 0;
    const { chat, push } = await mountStreaming({
      bootstrap: () => {
        boots += 1;
        return json(bootstrapInfo({
          messages: {
            messages: [message({ id: boots === 1 ? 'm_7' : 'm_10', seq: boots === 1 ? 7 : 10 })],
            hasMore: false,
            lastEventSeq: 60,
            lastMessageSeq: boots === 1 ? 7 : 10,
            oldestSeq: boots === 1 ? 7 : 10
          }
        }));
      }
    });

    await push('reply.text.delta', { messageId: 'm_9', delta: '会失败' });
    await push('reply.failed', { error: '上游超时' });
    expect(chat().streamingDraft).toBeNull();

    await push('reply.text.delta', { messageId: 'm_11', delta: '会重载' });
    await push('system.notice', { action: 'reload' });
    expect(chat().streamingDraft).toBeNull();
    expect(chat().messages.map((m) => m.id)).toEqual(['m_10']);
  });
});

describe('useChat 错误事件', () => {
  it('reply.failed 归零活动、合入服务端消息并暴露错误文案', async () => {
    const { chat, push } = await mountStreaming();
    await push('reply.thinking', {});
    await push('reply.text.delta', { messageId: 'm_9', delta: '未完成' });
    await push('reply.failed', {
      batchId: 'rb_1',
      revision: 1,
      failure: { code: 'model_timeout', retryable: true, message: '上游超时' },
      message: message({ id: 'm_9', seq: 9, status: 'failed' })
    });

    // 失败后必须停掉「正在思考」，否则界面会一直假装她还在写。
    expect(chat().streamingDraft).toBeNull();
    expect(chat().activity).toEqual({ thinking: false, label: null });
    expect(chat().error).toBeNull();
    expect(chat().replyFailures['rb_1:1']).toMatchObject({ message: '上游超时', code: 'model_timeout', retryable: true });
    expect(chat().messages.find((m) => m.id === 'm_9')!.status).toBe('failed');
  });

  it('reply.failed 的 error 不是字符串时回落到默认文案', async () => {
    const { chat, push } = await mountStreaming();
    await push('reply.failed', { error: { code: 'upstream_timeout' } });

    expect(chat().error).toBe('回复失败');
    // 没带 message 就不该凭空多出气泡。
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7']);
  });
});

describe('useChat 其他事件分派', () => {
  it('message.received 与 message.updated 都并入消息列表', async () => {
    const { chat, push } = await mountStreaming();

    await push('message.received', { message: message({ id: 'm_8', seq: 8, role: 'user' }) });
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8']);

    await push('message.updated', { message: message({ id: 'm_8', seq: 8, role: 'user', content: [part({ id: 'p_8', type: 'system', text: '已撤回' })] }) });
    // 同一 id 是就地更新，不是再插一条。
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8']);
    expect(chat().messages.at(-1)!.content.map((p) => [p.type, p.text])).toEqual([['system', '已撤回']]);
  });

  it('persona.updated 只覆盖事件里给出的字段', async () => {
    const { chat, push } = await mountStreaming();
    await push('persona.updated', { persona: { tagline: '忙着呢' } });

    // 后台只改了一句签名，头像和名字不能被抹成空。
    expect(chat().persona).toEqual({ name: 'SOOYA', avatar: '/avatars/sooya.svg', userAvatar: '/avatars/user.svg', tagline: '忙着呢' });
  });

  it('life.updated 重新读 /api/life 而不是信事件载荷', async () => {
    const { chat, push } = await mountStreaming({
      life: () => json({ activity: '在写字', kind: 'work', mood: '专注', startedAt: '2026-08-01T01:00:00.000Z', endsAt: '2026-08-01T02:00:00.000Z', recent: [] })
    });
    await push('life.updated', { activity: '别信这个字段' });

    expect(countCalls('/api/life')).toBe(1);
    expect(chat().life?.activity).toBe('在写字');
    expect(chat().error).toBeNull();
  });

  it('/api/life 失败时保留旧状态且不报错', async () => {
    const { chat, push } = await mountStreaming({ life: () => json({ message: '生活服务炸了' }, 500) });
    await push('life.updated', {});

    // 她在做什么只是聊天旁边的装饰，读不到也不能在界面上报错。
    expect(chat().error).toBeNull();
    expect(chat().life?.activity).toBe('在看书');
  });

  it('system.notice 的 reload 重跑 bootstrap', async () => {
    let boots = 0;
    const { chat, push } = await mountStreaming({
      bootstrap: () => {
        boots += 1;
        if (boots === 1) return json(bootstrapInfo());
        return json(bootstrapInfo({ messages: { messages: [message({ id: 'm_9', seq: 9 })], hasMore: false, lastEventSeq: 60, lastMessageSeq: 9, oldestSeq: 9 } }));
      }
    });
    await push('reply.thinking', {});
    await push('system.notice', { action: 'reload' });

    expect(boots).toBe(2);
    // reload 是整屏重置：列表换成新载荷，翻页标记和活动状态一起归零。
    expect(chat().messages.map((m) => m.id)).toEqual(['m_9']);
    expect(chat().hasMore).toBe(false);
    expect(chat().activity).toEqual({ thinking: false, label: null });
  });

  it('system.notice 的其他 action 只拉增量', async () => {
    const { chat, push } = await mountStreaming({ messages: () => messagePage([message({ id: 'm_8', seq: 8 })]) });
    await push('system.notice', { action: 'refresh' });

    // 普通通知不该把首屏整个重打一遍。
    expect(countCalls('/api/bootstrap')).toBe(1);
    expect(messageQueries()).toEqual(['/api/messages?limit=100&since=7']);
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8']);
  });
});

describe('useChat resync() 增量翻页', () => {
  it('按服务端游标连走多页直到 hasMore 为 false，跨页消息按 id 去重', async () => {
    let page = 0;
    stubRoutes({
      messages: () => {
        page += 1;
        if (page === 1) return messagePage([message({ id: 'm_7', seq: 7 }), message({ id: 'm_8', seq: 8 })], { hasMore: true, nextSince: 8 });
        return messagePage([message({ id: 'm_8', seq: 8 }), message({ id: 'm_9', seq: 9 })]);
      }
    });
    const chat = await mountChat();

    await act(async () => { await chat().resync(); });

    // 服务端每页有上限，claim 了 hasMore 就得带着 nextSince 再要一页，
    // 只打一次会把落下的消息永久丢掉。
    expect(messageQueries()).toEqual(['/api/messages?limit=100&since=7', '/api/messages?limit=100&since=8']);
    // 两页都回了 m_8，合并后只能有一条。
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8', 'm_9']);
    // 追增量的 hasMore 说的是「还有更新的消息」，不能拿它覆盖「还有更老的历史」。
    expect(chat().hasMore).toBe(true);
    expect(chat().error).toBeNull();
  });

  it('游标不前进时报错收场，不继续打请求', async () => {
    stubRoutes({ messages: () => messagePage([message({ id: 'm_7', seq: 7 })], { hasMore: true, nextSince: 7 }) });
    const chat = await mountChat();

    await act(async () => { await chat().resync(); });

    // nextSince 没超过当前游标，再要一次只会拿到同一页：必须停下来而不是空转。
    expect(messageQueries()).toEqual(['/api/messages?limit=100&since=7']);
    expect(chat().error).toBe('catch-up cursor stalled at seq 7');
    expect(chat().connection).toBe('online');
  });

  it('没有已知 seq 时改拉首页并更新 hasMore', async () => {
    stubRoutes({
      bootstrap: () => json(bootstrapInfo({ messages: { messages: [], hasMore: false, lastEventSeq: 42, lastMessageSeq: 0, oldestSeq: null } })),
      messages: () => messagePage([message({ id: 'm_1', seq: 1 }), message({ id: 'm_2', seq: 2 })], { hasMore: true })
    });
    const chat = await mountChat();
    expect(chat().messages).toEqual([]);

    await act(async () => { await chat().resync(); });

    // 一条都没有时 since=0 对服务端没意义，只能按首页大小重新要一页。
    expect(messageQueries()).toEqual(['/api/messages?limit=30']);
    expect(chat().messages.map((m) => m.id)).toEqual(['m_1', 'm_2']);
    expect(chat().hasMore).toBe(true);
    expect(chat().error).toBeNull();
  });

  it('resync 遇到 401 时置为未授权且不报文案', async () => {
    stubRoutes({ messages: () => json({ error: 'unauthorized' }, 401) });
    const chat = await mountChat();

    await act(async () => { await chat().resync(); });

    // 令牌失效是要去重新登录，不是往聊天界面上贴一条报错。
    expect(chat().connection).toBe('unauthorized');
    expect(chat().error).toBeNull();
  });

  it('resync 遇到其他错误时暴露服务端文案', async () => {
    stubRoutes({ messages: () => json({ message: '增量读不到' }, 500) });
    const chat = await mountChat();

    await act(async () => { await chat().resync(); });

    expect(chat().error).toBe('增量读不到');
    expect(chat().connection).toBe('online');
  });
});

describe('useChat loadOlder()', () => {
  it('按最老一条的 seq 往前翻一页并合入历史', async () => {
    stubRoutes({ messages: () => messagePage([message({ id: 'm_5', seq: 5 }), message({ id: 'm_6', seq: 6 })]) });
    const chat = await mountChat();

    await act(async () => { await chat().loadOlder(); });

    expect(messageQueries()).toEqual(['/api/messages?limit=30&before=7']);
    // 老消息要排在前面，顺序由 seq 决定而不是到达顺序。
    expect(chat().messages.map((m) => m.id)).toEqual(['m_5', 'm_6', 'm_7']);
    expect(chat().hasMore).toBe(false);
    expect(chat().loadingOlder).toBe(false);
  });

  it('请求挂起期间重复调用不会再打一次', async () => {
    const older = deferredResponse();
    stubRoutes({ messages: () => older.promise });
    const chat = await mountChat();

    let first!: Promise<boolean>;
    await act(async () => { first = chat().loadOlder(); });
    expect(chat().loadingOlder).toBe(true);

    // 用户连点「加载更早」不能变成并发翻页：同一页会被重复拉、还可能乱序合并。
    await act(async () => { await chat().loadOlder(); });
    expect(countCalls('/api/messages?')).toBe(1);

    await act(async () => {
      older.settle(messagePage([message({ id: 'm_6', seq: 6 })], { hasMore: true }));
      await first;
    });

    expect(chat().messages.map((m) => m.id)).toEqual(['m_6', 'm_7']);
    expect(chat().hasMore).toBe(true);
    expect(chat().loadingOlder).toBe(false);
  });

  it('hasMore 为 false 时直接返回，不发请求', async () => {
    stubRoutes({ bootstrap: () => json(bootstrapInfo({ messages: { messages: [message({ id: 'm_7', seq: 7 })], hasMore: false, lastEventSeq: 42, lastMessageSeq: 7, oldestSeq: 7 } })) });
    const chat = await mountChat();

    await act(async () => { await chat().loadOlder(); });

    // 已经翻到底了，再往前要只是白打一次请求。
    expect(messageQueries()).toEqual([]);
    expect(chat().error).toBeNull();
    expect(chat().loadingOlder).toBe(false);
  });

  it('翻页失败时暴露错误并复位 loadingOlder', async () => {
    stubRoutes({ messages: () => json({ message: '历史读不到' }, 500) });
    const chat = await mountChat();

    await act(async () => { await chat().loadOlder(); });

    expect(chat().error).toBe('历史读不到');
    // 卡在 true 会让「加载更早」永久按不动。
    expect(chat().loadingOlder).toBe(false);
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7']);
  });
});

describe('useChat 引用消息上下文', () => {
  it('按引用目标补取窗口并合入消息列表，避免重复请求', async () => {
    const target = message({ id: 'm_2', seq: 2, role: 'user' });
    const older = message({ id: 'm_1', seq: 1 });
    const newer = message({ id: 'm_3', seq: 3 });
    stubRoutes({
      messageContext: () => json({ target, messages: [older, target, newer], hasOlder: false, hasNewer: true })
    });
    const chat = await mountChat();

    let result!: ChatMessage | null;
    await act(async () => { result = await chat().ensureQuotedMessage(target.id); });

    expect(result?.id).toBe(target.id);
    expect(chat().messages.map((m) => m.id)).toEqual(['m_1', 'm_2', 'm_3', 'm_7']);
    expect(calls.filter((call) => call.url.startsWith('/api/messages/m_2/context?'))).toHaveLength(1);
    await act(async () => { await chat().ensureQuotedMessage(target.id); });
    expect(calls.filter((call) => call.url.startsWith('/api/messages/m_2/context?'))).toHaveLength(1);
  });
});

describe('useChat retryFailed()', () => {
  it('复用原 clientMsgId 重试，成功后失败条目被服务端消息替掉', async () => {
    let posts = 0;
    stubRoutes({
      send: () => {
        posts += 1;
        const { clientMsgId } = sendCalls().at(-1)!;
        if (posts === 1) return json({ message: '上游炸了' }, 500);
        return json({ message: message({ id: 'm_8', seq: 8, role: 'user', clientMsgId, content: [part({ id: 'p_8', text: '在吗' })] }), duplicate: true, replyPending: true });
      }
    });
    const chat = await mountChat();

    await act(async () => { await chat().send([{ type: 'text', text: '在吗' }]).catch(() => {}); });
    const failed = chat().messages.find((m) => m.pendingLocal)!;
    expect(failed.status).toBe('failed');

    await act(async () => { await chat().retryFailed(failed); });

    const payloads = sendCalls();
    expect(payloads).toHaveLength(2);
    // 换一个幂等键就等于再发一条：服务端已经收下的那次会变成重复消息。
    expect(payloads[1]!.clientMsgId).toBe(payloads[0]!.clientMsgId);
    expect(payloads[1]!.content).toEqual([{ type: 'text', text: '在吗' }]);
    // 服务端认下之后本地那条失败气泡必须消失，不能和真消息并列。
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7', 'm_8']);
    expect(chat().messages.some((m) => m.pendingLocal)).toBe(false);
    expect(chat().error).toBeNull();
  });

  it('消息没有 clientMsgId 时不把重试越界成再次发送', async () => {
    stubRoutes({
      bootstrap: () => json(bootstrapInfo({ messages: { messages: [message({ id: 'm_7', seq: 7, role: 'user', status: 'failed' })], hasMore: false, lastEventSeq: 42, lastMessageSeq: 7, oldestSeq: 7 } })),
      send: () => json({ message: message({ id: 'm_8', seq: 8, role: 'user', clientMsgId: sendCalls().at(-1)!.clientMsgId }), duplicate: false, replyPending: true })
    });
    const chat = await mountChat();

    await act(async () => { await chat().retryFailed(chat().messages[0]!); });

    const payloads = sendCalls();
    expect(payloads).toHaveLength(0);
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7']);
    expect(chat().messages.some((m) => m.pendingLocal)).toBe(false);
  });

  it('重试再失败时重新标记 failed，401 一并置为未授权', async () => {
    stubRoutes({
      bootstrap: () => json(bootstrapInfo({ messages: { messages: [message({ id: 'm_7', seq: 7, role: 'user', status: 'failed', clientMsgId: 'c_old' })], hasMore: false, lastEventSeq: 42, lastMessageSeq: 7, oldestSeq: 7 } })),
      send: () => json({ error: 'unauthorized' }, 401)
    });
    const chat = await mountChat();

    let failure: unknown;
    await act(async () => { failure = await chat().retryFailed(chat().messages[0]!).catch((err: unknown) => err); });

    expect((failure as Error).message).toBe('unauthorized');
    expect(sendCalls()[0]!.clientMsgId).toBe('c_old');
    // 中途置成的 pending 必须回到 failed，否则这条消息再也点不动重试。
    const still = chat().messages.find((m) => m.id === 'm_7')!;
    expect(still.status).toBe('failed');
    expect(still.error).toBe('unauthorized');
    expect(chat().connection).toBe('unauthorized');
    expect(chat().error).toBe('unauthorized');
  });

  it('sendAgain 使用新的 clientMsgId 创建独立消息', async () => {
    stubRoutes({
      bootstrap: () => json(bootstrapInfo({ messages: { messages: [message({ id: 'm_7', seq: 7, role: 'user', status: 'sent', clientMsgId: 'c_original' })], hasMore: false, lastEventSeq: 42, lastMessageSeq: 7, oldestSeq: 7 } })),
      send: () => json({ message: message({ id: 'm_8', seq: 8, role: 'user' }), duplicate: false, replyPending: true })
    });
    const chat = await mountChat();

    await act(async () => { await chat().sendAgain(chat().messages[0]!); });

    expect(sendCalls()).toHaveLength(1);
    expect(sendCalls()[0]!.clientMsgId).not.toBe('c_original');
    expect(chat().messages.map((item) => item.id)).toEqual(['m_7', 'm_8']);
  });
});

describe('useChat withdraw()', () => {
  it('打撤回接口并把返回的消息就地合入列表', async () => {
    stubRoutes({
      bootstrap: () => json(bootstrapInfo({ messages: { messages: [message({ id: 'm_7#a', seq: 7, role: 'user' })], hasMore: false, lastEventSeq: 42, lastMessageSeq: 7, oldestSeq: 7 } })),
      withdraw: () => json({ message: message({ id: 'm_7#a', seq: 7, role: 'user', content: [part({ id: 'p_1', type: 'system', text: '已撤回' })] }) })
    });
    const chat = await mountChat();

    let result: { message: ChatMessage } | undefined;
    await act(async () => { result = await chat().withdraw(chat().messages[0]!); });

    // id 要转义，否则带特殊字符的 id 会拼出错误路径甚至打到别的资源上。
    expect(calls.filter((call) => call.url.endsWith('/withdraw'))).toEqual([{ url: '/api/messages/m_7%23a/withdraw', method: 'POST', body: null }]);
    expect(result!.message.id).toBe('m_7#a');
    // 撤回是就地更新那一条，不是再插一条。
    expect(chat().messages.map((m) => m.id)).toEqual(['m_7#a']);
    expect(chat().messages[0]!.content.map((p) => [p.type, p.text])).toEqual([['system', '已撤回']]);
  });
});

describe('useChat 回前台重同步', () => {
  it('visibilitychange 与 focus 各触发一次 resync，hidden 不触发，卸载后不再请求', async () => {
    stubRoutes({ messages: () => messagePage([message({ id: 'm_7', seq: 7 })]) });
    const chat = await mountChat();
    expect(messageQueries()).toEqual([]);

    // 手机切回前台常常已经错过若干条消息，SSE 又可能被系统冻住，只能主动补一次。
    await dispatch(document, 'visibilitychange');
    expect(messageQueries()).toEqual(['/api/messages?limit=100&since=7']);
    expect(chat().error).toBeNull();

    await dispatch(window, 'focus');
    expect(messageQueries()).toHaveLength(2);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      // 切到后台还去拉增量只是白耗流量。
      await dispatch(document, 'visibilitychange');
      expect(messageQueries()).toHaveLength(2);
    } finally {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }
    expect(document.visibilityState).toBe('visible');

    await unmountAll();
    await dispatch(document, 'visibilitychange');
    await dispatch(window, 'focus');
    // 监听器没摘干净的话，卸载后的重同步会打到已经销毁的状态上。
    expect(messageQueries()).toHaveLength(2);
  });
});
