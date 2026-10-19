import { describe, expect, it } from 'vitest';
import { httpRequestTool, vaultSecretReader, type HttpRequestAudit, type HttpRequestDeps } from '../src/core/links/http-request.js';
import type { ToolDescriptor } from '../src/agent/registry.js';

const KEY = 'sk-live-THE-REAL-KEY-123';

interface Seen { url: string; method: string; headers: Record<string, string>; body?: string; via: 'direct' | 'proxy' }

function harness(routes: (call: Seen) => Response | Promise<Response>, overrides: Partial<HttpRequestDeps> = {}) {
  const calls: Seen[] = [];
  const audits: HttpRequestAudit[] = [];
  const make = (via: Seen['via']) => (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const call: Seen = { url: String(url), method: init?.method ?? 'GET', headers, ...(typeof init?.body === 'string' ? { body: init.body } : {}), via };
    calls.push(call);
    return routes(call);
  }) as typeof fetch;
  const tool = httpRequestTool({
    directFetchImpl: make('direct'),
    proxyFetchImpl: make('proxy'),
    readSecret: async (name) => (name === 'fish/api-key' ? KEY : null),
    onAudit: (event) => audits.push(event),
    ...overrides
  });
  return { tool, calls, audits, run: (input: Record<string, unknown>) => tool.handler(input as never, { phase: 'reply' }) as Promise<string> };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('http_request', () => {
  it('is a reply-phase local tool that declares allowInReply', () => {
    const { tool } = harness(() => json({}));
    expect(tool).toMatchObject({ modelName: 'http_request', source: 'local', risk: 'external_side_effect', phases: ['reply'], allowInReply: true });
  });

  it('refuses internal addresses, also when a redirect points into one', async () => {
    const { run } = harness(() => new Response('', { status: 302, headers: { location: 'http://10.0.0.5/admin' } }));
    await expect(run({ url: 'http://127.0.0.1:18201/mcp' })).rejects.toThrow(/不能访问/);
    await expect(run({ url: 'http://93.184.216.34/jump' })).rejects.toThrow(/不能访问.*内网/);
  });

  it('puts the key where auth says: bearer, a named header, or a query parameter', async () => {
    const { run, calls } = harness(() => json({ ok: true }));
    await run({ url: 'http://93.184.216.34/v1/models', secret: 'fish/api-key' });
    await run({ url: 'http://93.184.216.34/v1/models', secret: 'fish/api-key', auth: 'header:x-api-key' });
    await run({ url: 'http://93.184.216.34/v1/models?a=1', secret: 'fish/api-key', auth: 'query:key' });
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[1]!.headers['x-api-key']).toBe(KEY);
    expect(calls[1]!.headers.authorization).toBeUndefined();
    expect(new URL(calls[2]!.url).searchParams.get('key')).toBe(KEY);
    expect(new URL(calls[2]!.url).searchParams.get('a')).toBe('1');
  });

  it('drops the key when a redirect leaves the origin, keeps it on the same origin', async () => {
    const { run, calls } = harness((call) => {
      const url = new URL(call.url);
      if (url.pathname === '/start') return new Response('', { status: 302, headers: { location: '/same' } });
      if (url.pathname === '/same') return new Response('', { status: 307, headers: { location: `http://93.184.216.99/elsewhere?key=${KEY}&x=1` } });
      return json({ landed: true });
    });
    await run({ url: 'http://93.184.216.34/start', secret: 'fish/api-key' });
    await run({ url: 'http://93.184.216.34/start', secret: 'fish/api-key', auth: 'query:key' });
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[2]!.headers.authorization).toBeUndefined();
    expect(calls[5]!.url).not.toContain(KEY);
    expect(new URL(calls[5]!.url).searchParams.get('x')).toBe('1');
  });

  it('masks the key wherever the API echoes it: body, headers and errors', async () => {
    const { run } = harness(() => json({ echo: `you sent ${KEY}`, encoded: encodeURIComponent(KEY) }, { headers: { 'content-type': 'application/json', location: `https://x.test/?k=${KEY}` } }));
    const text = await run({ url: 'http://93.184.216.34/echo', secret: 'fish/api-key' });
    expect(text).not.toContain(KEY);
    expect(text).toContain('[密钥]');

    const failing = harness(() => { throw new Error(`boom ${KEY}`); });
    const error = await failing.run({ url: 'http://93.184.216.34/x', secret: 'fish/api-key' }).catch((e: Error) => e.message);
    expect(error).not.toContain(KEY);
  });

  it('says plainly when the vault has no such secret', async () => {
    const { run, calls } = harness(() => json({}));
    await expect(run({ url: 'http://93.184.216.34/x', secret: 'nope' })).rejects.toThrow(/密钥库里没有叫 nope 的 Key/);
    expect(calls).toHaveLength(0);
  });

  it('serialises an object body as JSON and returns status plus a few headers', async () => {
    const { run, calls } = harness(() => json({ id: 7 }, { status: 201, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9', 'set-cookie': 'a=b' } }));
    const text = await run({ url: 'http://93.184.216.34/items', method: 'post', body: { name: '海' } });
    expect(calls[0]).toMatchObject({ method: 'POST', body: '{"name":"海"}' });
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(text).toMatch(/^HTTP 201/);
    expect(text).toContain('x-ratelimit-remaining: 9');
    expect(text).not.toContain('set-cookie');
    expect(text).toContain('"id": 7');
  });

  it('gives only type and size for binary bodies, and truncates long JSON', async () => {
    const binary = harness(() => new Response(new Uint8Array(2048), { headers: { 'content-type': 'audio/mpeg', 'content-length': '2048' } }));
    const audio = await binary.run({ url: 'http://93.184.216.34/tts' });
    expect(audio).toContain('二进制内容，audio/mpeg，2.0 KB');

    const big = harness(() => json({ items: Array.from({ length: 3000 }, (_, i) => ({ i, name: `item-${i}` })) }));
    const text = await big.run({ url: 'http://93.184.216.34/list' });
    expect(Buffer.byteLength(text)).toBeLessThan(17 * 1024);
    expect(text).toContain('这里只给前 16.0 KB');
  });

  it('retries through the proxy when the direct attempt fails fast, and says so', async () => {
    const { run, calls, audits } = harness((call) => {
      if (call.via === 'direct') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return json({ via: 'proxy' });
    });
    const text = await run({ url: 'http://93.184.216.34/api' });
    expect(calls.map((call) => call.via)).toEqual(['direct', 'proxy']);
    expect(text).toContain('已改走代理');
    expect(audits[0]).toMatchObject({ viaProxy: true, status: 200, host: '93.184.216.34' });
  });

  it('lets a lookup failure through when going via the proxy (resolved on the far side)', async () => {
    const dnsFail = async () => { throw new Error('dns resolution failed for blocked.example: ENOTFOUND'); };
    const { run, calls } = harness(() => json({ ok: 1 }), { assertUrl: dnsFail });
    await run({ url: 'https://blocked.example/v1', proxy: true });
    expect(calls.map((call) => call.via)).toEqual(['proxy']);
    // directly it falls back to the proxy for the same reason
    await run({ url: 'https://blocked.example/v1' });
    expect(calls.map((call) => call.via)).toEqual(['proxy', 'proxy']);
  });

  it('times out with a Chinese error instead of hanging, even if the transport ignores abort', async () => {
    const slow = harness(() => new Promise<Response>(() => undefined), { timeoutMs: 50 });
    await expect(slow.run({ url: 'http://93.184.216.34/slow' })).rejects.toThrow('请求超时');
    expect(slow.audits[0]).toMatchObject({ status: null, error: expect.stringContaining('超时') });

    const controller = new AbortController();
    const pending = slow.tool.handler({ url: 'http://93.184.216.34/slow' } as never, { phase: 'reply', signal: controller.signal });
    controller.abort(new Error('reply superseded'));
    await expect(pending).rejects.toThrow('reply superseded');
  });

  it('logs method, host, status and the secret name, never the value', async () => {
    const { run, audits } = harness(() => json({}));
    await run({ url: 'http://93.184.216.34/v1/models', secret: 'fish/api-key' });
    expect(audits[0]).toMatchObject({ method: 'GET', host: '93.184.216.34', status: 200, secret: 'fish/api-key', viaProxy: false });
    expect(JSON.stringify(audits)).not.toContain(KEY);
  });
});

describe('vaultSecretReader', () => {
  const vault = (result: unknown): ToolDescriptor => ({
    name: 'knowledge.secret.read', modelName: 'knowledge__secret_read', description: 'x', inputSchema: { type: 'object' },
    source: 'mcp', serverId: 'knowledge', risk: 'read', phases: ['reply'], handler: async () => result
  });

  it('reads the value out of the MCP JSON text', async () => {
    const read = vaultSecretReader(() => vault({ __sooya_mcp_result__: true, isError: false, value: JSON.stringify({ name: 'a', value: KEY, updated_at: 'x' }) }));
    expect(await read('a')).toBe(KEY);
  });

  it('treats an MCP error as a missing secret and a missing vault as an error', async () => {
    expect(await vaultSecretReader(() => vault({ __sooya_mcp_result__: true, isError: true, value: 'not found' }))('a')).toBeNull();
    await expect(vaultSecretReader(() => undefined)('a')).rejects.toThrow(/密钥库/);
  });
});
