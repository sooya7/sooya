// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, getToken, mediaUrl, setToken } from './api.js';
import * as apiModule from './api.js';
import { clearAdminToken, getAdminToken, setAdminToken } from './admin.js';

interface Call {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: BodyInit | null | undefined;
}

/**
 * `api.ts` 是用户侧主链路的请求层，和 `admin.ts` / `features.ts` 各有一份独立的
 * `request()`。这里只覆盖它自己那份行为：`x-sooya-token` 头、content-type 的
 * 「调用方优先」判断、`messages()` 的查询串拼装、`upload()` 的 FormData 组装，
 * 以及它自己的响应解析与错误消息优先级。
 */
function captureFetch(respond: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method, headers: new Headers(init.headers), body: init.body };
    calls.push(call);
    return respond(call);
  }));
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 记录请求，并用同一份 JSON 应答全部请求。 */
function recording(body: unknown = { ok: true }, status = 200): Call[] {
  return captureFetch(() => json(body, status));
}

/**
 * 隐私模式模拟。必须打在 `Storage.prototype` 上：jsdom 的 `localStorage` 是个代理，
 * 对实例 `defineProperty` 会被当成写入一条存储项，`vi.spyOn(window.localStorage, ...)`
 * 根本不会生效，用例会静默空过。
 */
function denyStorage(method: 'getItem' | 'setItem' | 'removeItem') {
  return vi.spyOn(Storage.prototype, method).mockImplementation(() => {
    throw new Error('private mode');
  });
}

/** 把 `fetch` 收到的 body 当成 FormData 读回条目，保持 append 顺序。 */
function formEntries(body: BodyInit | null | undefined): Array<[string, string]> {
  const form = body as FormData;
  return [...form.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : value.name] as [string, string]);
}

afterEach(() => {
  vi.restoreAllMocks();
  clearAdminToken();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('用户令牌存取', () => {
  it('未设置时返回 null，设置后读回，存在 sooya.token 键上', () => {
    expect(getToken()).toBeNull();

    setToken('user-secret');

    expect(getToken()).toBe('user-secret');
    expect(localStorage.getItem('sooya.token')).toBe('user-secret');
  });

  it('与 admin.ts 的管理令牌互不干扰', () => {
    setToken('user-secret');
    setAdminToken('admin-secret');

    expect(getToken()).toBe('user-secret');
    expect(getAdminToken()).toBe('admin-secret');

    clearAdminToken();
    expect(getToken()).toBe('user-secret');
  });

  it('getItem 抛异常（隐私模式）时 getToken 返回 null 而不外抛', () => {
    setToken('user-secret');
    const spy = denyStorage('getItem');

    expect(() => getToken()).not.toThrow();
    expect(getToken()).toBeNull();
    expect(spy).toHaveBeenCalledWith('sooya.token');
  });

  it('setItem 抛异常时 setToken 不外抛', () => {
    const spy = denyStorage('setItem');

    expect(() => setToken('user-secret')).not.toThrow();
    expect(spy).toHaveBeenCalledWith('sooya.token', 'user-secret');
  });

  it('api.ts 不提供清除令牌的函数（与 admin.ts 的 clearAdminToken 不同）', () => {
    expect(typeof apiModule.getToken).toBe('function');
    expect(typeof apiModule.setToken).toBe('function');
    expect(Object.keys(apiModule).some((name) => /^clear/.test(name))).toBe(false);
  });
});

describe('request 请求构造', () => {
  it('有令牌时带 x-sooya-token 头', async () => {
    setToken('user-secret');
    const calls = recording();

    await api.bootstrap();

    expect(calls[0]!.headers.get('x-sooya-token')).toBe('user-secret');
  });

  it('无令牌时不发鉴权头', async () => {
    const calls = recording();

    await api.bootstrap();

    expect(calls[0]!.headers.has('x-sooya-token')).toBe(false);
  });

  it('读令牌失败时请求照常发出，只是不带鉴权头', async () => {
    setToken('user-secret');
    const spy = denyStorage('getItem');
    const calls = recording();

    await expect(api.bootstrap()).resolves.toEqual({ ok: true });

    expect(spy).toHaveBeenCalledWith('sooya.token');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.has('x-sooya-token')).toBe(false);
  });

  it('JSON body 会设 content-type', async () => {
    const calls = recording();

    await api.send({ clientMsgId: 'c1', content: [] });

    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('FormData body 不设 content-type（留给浏览器加 boundary）', async () => {
    const calls = recording();

    await api.upload([{ file: new File(['x'], 'a.png', { type: 'image/png' }), field: 'image' }]);

    expect(calls[0]!.headers.has('content-type')).toBe(false);
  });

  it('无 body 的写操作不设 content-type', async () => {
    const calls = recording();

    await api.withdraw('msg_1');

    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers.has('content-type')).toBe(false);
  });

  it('读操作不带 method，落到 fetch 默认的 GET', async () => {
    const calls = recording();

    await api.bootstrap();

    expect(calls[0]!.method).toBeUndefined();
  });

  /*
   * `request()` 的 content-type 判断多了 `!headers.has('content-type')`（`admin.ts`
   * 会无条件覆盖），`init` 的其他字段（如 `signal`）也会被 `{ ...init, headers }` 透传。
   * 这两条都只能由调用方传 `headers` / `signal` 才能触发，而 `request` 未导出、公开的
   * `api` 九个方法没有一个传这两个字段，所以在不改动实现的前提下无法真实覆盖。
   * 这里不伪造覆盖，等真有方法用到时再补。
   */
});

describe('响应解析与错误', () => {
  it('空响应体返回 null', async () => {
    captureFetch(() => new Response('', { status: 200 }));

    await expect(api.bootstrap()).resolves.toBeNull();
  });

  it('非 JSON 文本原样返回', async () => {
    captureFetch(() => new Response('plain text', { status: 200 }));

    await expect(api.bootstrap()).resolves.toBe('plain text');
  });

  it('JSON 解析成对象返回', async () => {
    recording({ conversation: { conversationId: 'main' } });

    await expect(api.bootstrap()).resolves.toEqual({ conversation: { conversationId: 'main' } });
  });

  it('非 2xx 抛 ApiError，带 status 与原始 body', async () => {
    recording({ message: 'nope', detail: 1 }, 418);

    const err = await api.bootstrap().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).name).toBe('ApiError');
    expect((err as ApiError).status).toBe(418);
    expect((err as ApiError).body).toEqual({ message: 'nope', detail: 1 });
  });

  it('错误消息优先取 message', async () => {
    recording({ message: 'from-message', error: 'from-error' }, 400);

    await expect(api.bootstrap()).rejects.toThrow('from-message');
  });

  it('没有 message 时退到 error', async () => {
    recording({ error: 'from-error' }, 400);

    await expect(api.bootstrap()).rejects.toThrow('from-error');
  });

  it('两者都没有时用 request failed (<status>)', async () => {
    recording({}, 503);

    await expect(api.bootstrap()).rejects.toThrow('request failed (503)');
  });

  it('错误体为空时同样用 request failed (<status>)', async () => {
    captureFetch(() => new Response('', { status: 401 }));

    const err = await api.bootstrap().catch((e: unknown) => e);

    expect((err as ApiError).message).toBe('request failed (401)');
    expect((err as ApiError).body).toBeNull();
  });

  it('401 不会清空本地令牌（当前契约：没有这类副作用）', async () => {
    setToken('user-secret');
    recording({ error: 'unauthorized' }, 401);

    await expect(api.bootstrap()).rejects.toThrow('unauthorized');

    expect(getToken()).toBe('user-secret');
  });
});

describe('messages 查询串拼装', () => {
  it('不传参数时 URL 仍带一个空查询串的问号', async () => {
    const calls = recording();

    await api.messages();

    expect(calls[0]!.url).toBe('/api/messages?');
  });

  it('limit 用真值判断，limit: 0 会被跳过', async () => {
    const calls = recording();

    await api.messages({ limit: 50 });
    await api.messages({ limit: 0 });

    expect(calls[0]!.url).toBe('/api/messages?limit=50');
    expect(calls[1]!.url).toBe('/api/messages?');
  });

  it('before / since 用 !== undefined 判断，0 会被保留', async () => {
    const calls = recording();

    await api.messages({ before: 0 });
    await api.messages({ since: 0 });

    expect(calls[0]!.url).toBe('/api/messages?before=0');
    expect(calls[1]!.url).toBe('/api/messages?since=0');
  });

  it('三个参数同时给出时按 limit / before / since 顺序拼接', async () => {
    const calls = recording();

    await api.messages({ limit: 20, before: 5, since: 1 });

    expect(calls[0]!.url).toBe('/api/messages?limit=20&before=5&since=1');
  });
});

describe('端点 URL 与 method', () => {
  const cases: Array<[string, () => Promise<unknown>, string, string | undefined]> = [
    ['bootstrap', () => api.bootstrap(), '/api/bootstrap', undefined],
    ['capabilities', () => api.capabilities(), '/api/capabilities', undefined],
    ['life', () => api.life(), '/api/life', undefined],
    ['events', () => api.events(42), '/api/events?since=42', undefined],
    ['send', () => api.send({ clientMsgId: 'c1', content: [] }), '/api/messages', 'POST'],
    ['withdraw', () => api.withdraw('msg_1'), '/api/messages/msg_1/withdraw', 'POST']
  ];

  it.each(cases)('%s 打到 %s', async (_name, run, url, method) => {
    const calls = recording();

    await run();

    expect(calls[0]!.url).toBe(url);
    expect(calls[0]!.method).toBe(method);
  });

  it('events 的 since 直接拼进查询串', async () => {
    const calls = recording();

    await api.events(0);

    expect(calls[0]!.url).toBe('/api/events?since=0');
  });

  it('withdraw 会对消息 id 转义', async () => {
    const calls = recording();

    await api.withdraw('msg a/b#c');

    expect(calls[0]!.url).toBe('/api/messages/msg%20a%2Fb%23c/withdraw');
  });

  it('send 的 body 是调用方自己 stringify 的 JSON', async () => {
    const calls = recording();
    const payload = { clientMsgId: 'c1', content: [{ type: 'text', text: 'hi' }], directives: { push: true }, replyTo: 'msg_0' };

    await api.send(payload);

    expect(calls[0]!.body).toBe(JSON.stringify(payload));
    expect(JSON.parse(calls[0]!.body as string)).toEqual(payload);
  });
});

describe('upload 的 FormData 组装', () => {
  it('按 field 命名，File 没有显式 name 时用 File.name', async () => {
    const calls = recording();

    await api.upload([{ file: new File(['x'], 'photo.png', { type: 'image/png' }), field: 'image' }]);

    expect(formEntries(calls[0]!.body)).toEqual([['image', 'photo.png']]);
  });

  it('显式 name 优先于 File.name', async () => {
    const calls = recording();

    await api.upload([{ file: new File(['x'], 'photo.png', { type: 'image/png' }), field: 'file', name: 'renamed.bin' }]);

    expect(formEntries(calls[0]!.body)).toEqual([['file', 'renamed.bin']]);
  });

  it('Blob 且无显式 name 时回退到 upload', async () => {
    const calls = recording();

    await api.upload([{ file: new Blob(['x'], { type: 'application/octet-stream' }), field: 'file' }]);

    expect(formEntries(calls[0]!.body)).toEqual([['file', 'upload']]);
  });

  it('打到 /api/media 的 POST，且带鉴权头', async () => {
    setToken('user-secret');
    const calls = recording();

    await api.upload([{ file: new File(['x'], 'a.png'), field: 'image' }]);

    expect(calls[0]!.url).toBe('/api/media');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.get('x-sooya-token')).toBe('user-secret');
  });
});

describe('mediaUrl', () => {
  it('剥掉 URL 里的令牌查询参数，保留其余查询串', () => {
    expect(mediaUrl('/api/media/media_1?token=secret&w=240')).toBe('/api/media/media_1?w=240');
    expect(mediaUrl('/api/media/media_1?admin_token=secret')).toBe('/api/media/media_1');
  });

  it('无令牌参数时原样返回路径', () => {
    expect(mediaUrl('/api/media/media_1')).toBe('/api/media/media_1');
  });
});
