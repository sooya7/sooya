// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { featureApi } from './features.js';
import { ApiError } from './api.js';
import { ADMIN_UNAUTHORIZED_EVENT, clearAdminToken, getAdminToken, setAdminToken } from './admin.js';

interface Call {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: BodyInit | null | undefined;
}

/**
 * Every admin panel request goes through the same private `request()` helper, so
 * the assertions below drive it through the public `featureApi` methods and read
 * back what reached `fetch`.
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

/** Records requests and answers all of them with the same JSON payload. */
function recording(body: unknown = { ok: true }, status = 200): Call[] {
  return captureFetch(() => json(body, status));
}

afterEach(() => {
  clearAdminToken();
  vi.unstubAllGlobals();
});

describe('features request() 鉴权与请求体', () => {
  it('子页接口鉴权失效时清除令牌并发出统一通知', async () => {
    setAdminToken('expired-secret');
    const unauthorized = vi.fn();
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, unauthorized);
    recording({ message: '令牌已过期' }, 403);

    await expect(featureApi.life()).rejects.toThrow('令牌已过期');

    expect(getAdminToken()).toBeNull();
    expect(unauthorized).toHaveBeenCalledTimes(1);
    window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, unauthorized);
  });

  it('子页旧请求的 403 不会清除刚换上的新令牌', async () => {
    let respond!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
    const unauthorized = vi.fn();
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, unauthorized);
    setAdminToken('old-secret');

    const pending = featureApi.life();
    setAdminToken('new-secret');
    respond(json({ message: 'old token expired' }, 403));
    await expect(pending).rejects.toBeInstanceOf(ApiError);

    expect(getAdminToken()).toBe('new-secret');
    expect(unauthorized).not.toHaveBeenCalled();
    window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, unauthorized);
  });

  it('有 admin 令牌时带 x-admin-token', async () => {
    setAdminToken('admin-secret');
    const calls = recording();

    await featureApi.life();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/admin/life');
    expect(calls[0]!.headers.get('x-admin-token')).toBe('admin-secret');
  });

  it('没有令牌时不发送 x-admin-token 头', async () => {
    const calls = recording();

    await featureApi.life();

    expect(calls[0]!.headers.has('x-admin-token')).toBe(false);
  });

  it('不传 body 时默认 GET 且不设 content-type', async () => {
    const calls = recording();

    await featureApi.audit();

    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.has('content-type')).toBe(false);
    expect(calls[0]!.body).toBeUndefined();
  });

  it('普通对象 body 序列化为 JSON 并带 content-type，method 用传入值', async () => {
    const calls = recording({ settings: {} });

    await featureApi.updateLifeSettings({ reachOut: true, quietGapMinutes: 90 });

    expect(calls[0]!.url).toBe('/api/admin/life/settings');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(calls[0]!.body).toBe(JSON.stringify({ reachOut: true, quietGapMinutes: 90 }));
  });

  it('没有 body 的写操作仍用传入的 method', async () => {
    const calls = recording({ changed: false });

    await featureApi.tickLife();

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.has('content-type')).toBe(false);
  });

  it('FormData body 原样交给 fetch，且不能设 content-type（否则丢 multipart boundary）', async () => {
    const calls = recording({ persona: {}, media: {} });
    const file = new File(['avatar-bytes'], 'she.png', { type: 'image/png' });

    await featureApi.uploadAvatar('assistant', file);

    expect(calls[0]!.url).toBe('/api/admin/persona/avatar/assistant');
    expect(calls[0]!.method).toBe('POST');
    // Setting content-type by hand would omit the boundary and break the upload.
    expect(calls[0]!.headers.has('content-type')).toBe(false);
    expect(calls[0]!.body).toBeInstanceOf(FormData);
    const sent = (calls[0]!.body as FormData).get('file');
    expect(sent).toBeInstanceOf(File);
    expect((sent as File).name).toBe('she.png');
  });
});

describe('features request() 响应解析', () => {
  it('raw 请求在 2xx 时返回 blob，不做 JSON 解析', async () => {
    captureFetch(() => new Response('not-json-audio-bytes', { status: 200, headers: { 'content-type': 'audio/mpeg' } }));

    const blob = await featureApi.previewVoice('你好', 'happy');

    // jsdom's `Blob` global is a different realm than the one undici's Response
    // hands back, so assert observable behaviour instead of `instanceof`.
    expect(blob.type).toBe('audio/mpeg');
    expect(await blob.text()).toBe('not-json-audio-bytes');
  });

  it('raw 请求遇到非 2xx 仍走错误分支', async () => {
    captureFetch(() => json({ message: '语音供应商未配置' }, 503));

    await expect(featureApi.previewVoice('你好', 'happy')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      message: '语音供应商未配置'
    });
  });

  it('正常 JSON 响应返回解析后的对象', async () => {
    captureFetch(() => json({ settings: {} }));

    await expect(featureApi.life()).resolves.toEqual({ settings: {} });
  });

  it('空响应体返回 null', async () => {
    captureFetch(() => new Response('', { status: 200 }));

    await expect(featureApi.audit()).resolves.toBeNull();
  });

  it('非 JSON 文本不抛解析异常，原样作为结果返回', async () => {
    captureFetch(() => new Response('boom', { status: 200, headers: { 'content-type': 'text/plain' } }));

    await expect(featureApi.audit()).resolves.toBe('boom');
  });

  it('非 JSON 错误体原样进 ApiError.body，消息回退到状态码', async () => {
    captureFetch(() => new Response('boom', { status: 502, headers: { 'content-type': 'text/plain' } }));

    const error = await featureApi.audit().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).body).toBe('boom');
    expect((error as ApiError).message).toBe('request failed (502)');
  });

  it('错误消息优先用 message，其次 error，都没有才用状态码', async () => {
    captureFetch(() => json({ message: '先用这个', error: '不该用这个' }, 400));
    await expect(featureApi.audit()).rejects.toThrow('先用这个');
    vi.unstubAllGlobals();

    captureFetch(() => json({ error: '只有 error' }, 409));
    await expect(featureApi.audit()).rejects.toThrow('只有 error');
    vi.unstubAllGlobals();

    captureFetch(() => json({ detail: '字段名不认识' }, 500));
    await expect(featureApi.audit()).rejects.toThrow('request failed (500)');
  });
});

describe('features params() 查询串拼装', () => {
  it('undefined 与空字符串被跳过', async () => {
    const calls = recording({ media: [], stats: {}, total: 0 });

    await featureApi.gallery({ origin: undefined, search: '', limit: 20 });

    expect(calls[0]!.url).toBe('/api/admin/gallery?limit=20');
  });

  it('false 与 0 不能被跳过', async () => {
    const calls = recording({ media: [], stats: {}, total: 0 });

    await featureApi.gallery({ trash: false, favorite: false, limit: 0, offset: 0 });

    expect(calls[0]!.url).toBe('/api/admin/gallery?trash=false&favorite=false&limit=0&offset=0');
  });

  it('数字与布尔值转成字符串，参数全为空时 URL 不带 ?', async () => {
    const calls = recording({ media: [], stats: {}, total: 0 });

    await featureApi.gallery({ search: '' });

    expect(calls[0]!.url).toBe('/api/admin/gallery');
  });

  it('查询值里的特殊字符被编码', async () => {
    const calls = recording({ media: [], stats: {}, total: 0 });

    await featureApi.gallery({ search: 'a b&c=d' });

    expect(calls[0]!.url).toBe('/api/admin/gallery?search=a+b%26c%3Dd');
  });
});

describe('features 路径里的 id 转义', () => {
  it('patchMedia 对 id 做 encodeURIComponent', async () => {
    const calls = recording({ media: {} });

    await featureApi.patchMedia('a/b c', { favorite: true });

    expect(calls[0]!.url).toBe('/api/admin/media/a%2Fb%20c');
    expect(calls[0]!.method).toBe('PATCH');
  });

  it('媒体的 trash / restore / permanent 路径都转义 id', async () => {
    const calls = recording({ ok: true });

    await featureApi.trashMedia('a/b');
    await featureApi.restoreMedia('a/b');
    await featureApi.deleteMedia('a/b');

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/admin/media/a%2Fb/trash',
      'POST /api/admin/media/a%2Fb/restore',
      'DELETE /api/admin/media/a%2Fb/permanent'
    ]);
  });

});
