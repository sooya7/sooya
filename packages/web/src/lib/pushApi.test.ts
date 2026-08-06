// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPushApi } from './pushApi.js';
import { clearToken, setToken } from './api.js';

afterEach(() => {
  clearToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function captureFetch(status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: new Headers(init.headers) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

describe('requestPushApi', () => {
  it('带上聊天令牌和 json 内容类型', async () => {
    setToken('chat-secret');
    const calls = captureFetch();

    await requestPushApi('/api/push/status');

    expect(calls[0]?.headers.get('x-sooya-token')).toBe('chat-secret');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('调用方传了自定义头也不会丢掉鉴权', async () => {
    // The old code was `init.headers ?? authHeaders()`, so one custom header wiped the
    // token and produced an unexplained 401.
    setToken('chat-secret');
    const calls = captureFetch();

    await requestPushApi('/api/push/subscribe', { method: 'POST', headers: { 'x-trace': 'abc' } });

    expect(calls[0]?.headers.get('x-trace')).toBe('abc');
    expect(calls[0]?.headers.get('x-sooya-token')).toBe('chat-secret');
  });

  it('调用方显式覆盖同名头时以调用方为准', async () => {
    setToken('chat-secret');
    const calls = captureFetch();

    await requestPushApi('/api/push/subscribe', { headers: { 'content-type': 'text/plain' } });

    expect(calls[0]?.headers.get('content-type')).toBe('text/plain');
  });

  it('没有令牌时不发送空的鉴权头', async () => {
    clearToken();
    const calls = captureFetch();

    await requestPushApi('/api/push/status');

    expect(calls[0]?.headers.has('x-sooya-token')).toBe(false);
  });

  it('失败时抛出服务端给的说明', async () => {
    captureFetch(503, { message: '通知服务暂时不可用' });

    await expect(requestPushApi('/api/push/status')).rejects.toThrow('通知服务暂时不可用');
  });

  it('响应不是 json 也要报出状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));

    await expect(requestPushApi('/api/push/status')).rejects.toThrow('通知请求失败 (502)');
  });
});
