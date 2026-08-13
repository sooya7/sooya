// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_UNAUTHORIZED_EVENT, adminApi, clearAdminToken, getAdminToken, setAdminToken } from './admin.js';
import { ApiError, getToken, setToken } from './api.js';
import { acquireAuthenticatedMedia, clearMediaCache, takeCachedMedia } from './authenticatedMedia.js';
import type { ModelPreset } from './modelPresets.js';

interface Call {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: BodyInit | null | undefined;
}

/**
 * `admin.ts` keeps its own copy of the request helper, so these assertions drive
 * the public `adminApi` surface and read back what reached `fetch`. The overlap
 * with `features.test.ts` is deliberate only where `adminRequest()` differs:
 * caller supplied `headers`, the `X-Admin-Token` spelling, and the token
 * accessors that every other module reads through.
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

afterEach(() => {
  clearMediaCache();
  clearAdminToken();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('admin 令牌存取', () => {
  it('未设置时返回 null，设置后读回，清除后回到 null', () => {
    expect(getAdminToken()).toBeNull();

    setAdminToken('admin-secret');
    expect(getAdminToken()).toBe('admin-secret');

    clearAdminToken();
    expect(getAdminToken()).toBeNull();
  });

  it('令牌存在 sooya.admin-token 键上，与 api.ts 的用户令牌互不干扰', () => {
    setAdminToken('admin-secret');
    setToken('user-secret');

    expect(localStorage.getItem('sooya.admin-token')).toBe('admin-secret');
    expect(getAdminToken()).toBe('admin-secret');
    expect(getToken()).toBe('user-secret');

    clearAdminToken();
    expect(getAdminToken()).toBeNull();
    expect(getToken()).toBe('user-secret');
  });

  it('getItem 抛异常（隐私模式）时 getAdminToken 返回 null 而不外抛', () => {
    setAdminToken('admin-secret');
    const spy = denyStorage('getItem');

    expect(() => getAdminToken()).not.toThrow();
    expect(getAdminToken()).toBeNull();
    expect(spy).toHaveBeenCalledWith('sooya.admin-token');
  });

  it('setItem 抛异常时 setAdminToken 不外抛', () => {
    const spy = denyStorage('setItem');

    expect(() => setAdminToken('admin-secret')).not.toThrow();
    expect(spy).toHaveBeenCalledWith('sooya.admin-token', 'admin-secret');
  });

  it('removeItem 抛异常时 clearAdminToken 不外抛', () => {
    setAdminToken('admin-secret');
    const spy = denyStorage('removeItem');

    expect(() => clearAdminToken()).not.toThrow();
    expect(spy).toHaveBeenCalledWith('sooya.admin-token');
  });

  it('管理令牌只在值变化或清除时失效 admin 媒体缓存', async () => {
    let created = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:admin-token-${++created}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })));
    setToken('user-secret');
    setAdminToken('admin-secret');
    await acquireAuthenticatedMedia('/api/media/user-admin-test', { scope: 'user', token: 'user-secret', expected: 'image' });
    await acquireAuthenticatedMedia('/api/media/admin-admin-test', { scope: 'admin', token: 'admin-secret', expected: 'image' });

    setAdminToken('admin-secret');
    expect(takeCachedMedia('/api/media/admin-admin-test', { scope: 'admin', expected: 'image' })).not.toBeNull();

    setAdminToken('next-secret');
    expect(takeCachedMedia('/api/media/admin-admin-test', { scope: 'admin', expected: 'image' })).toBeNull();
    expect(takeCachedMedia('/api/media/user-admin-test', { scope: 'user', expected: 'image' })).not.toBeNull();

    await acquireAuthenticatedMedia('/api/media/admin-after-replace', { scope: 'admin', token: 'next-secret', expected: 'image' });
    clearAdminToken();
    expect(takeCachedMedia('/api/media/admin-after-replace', { scope: 'admin', expected: 'image' })).toBeNull();
  });

  it('读令牌抛异常时请求照常发出，只是不带鉴权头', async () => {
    setAdminToken('admin-secret');
    denyStorage('getItem');
    const calls = recording();

    await adminApi.system();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.has('x-admin-token')).toBe(false);
  });
});

describe('adminRequest 鉴权头与调用方自定义头', () => {
  it('有令牌时带 X-Admin-Token 头', async () => {
    setAdminToken('admin-secret');
    const calls = recording();

    await adminApi.system();

    expect(calls[0]!.headers.get('x-admin-token')).toBe('admin-secret');
  });

  it('没有令牌时不发送 X-Admin-Token 头', async () => {
    const calls = recording();

    await adminApi.system();

    expect(calls[0]!.headers.has('x-admin-token')).toBe(false);
  });

  // `adminRequest` 还接受调用方自定义 `headers`，但 `adminApi` 里没有任何方法传这个参数，
  // 从公开接口触达不到；写死鉴权头顺序（先 new Headers(options.headers) 再 set）的回归价值
  // 要等真有方法用它时再补，这里不为了凑覆盖率去直接调私有实现。

  it('鉴权头名对大小写不敏感地读得到，且写的是 X-Admin-Token', async () => {
    setAdminToken('admin-secret');
    const calls = recording();

    await adminApi.system();

    expect(calls[0]!.headers.get('X-Admin-Token')).toBe('admin-secret');
    expect(calls[0]!.headers.get('x-admin-token')).toBe('admin-secret');
  });
});

describe('adminRequest 请求体与默认 method', () => {
  it('不传 method 时默认 GET，且不带 body 与 content-type', async () => {
    const calls = recording();

    await adminApi.system();

    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers.has('content-type')).toBe(false);
  });

  it('普通对象 body 走 JSON.stringify 并设 content-type', async () => {
    const calls = recording();

    await adminApi.updatePersona({ name: '回声', tagline: '在线' });

    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(calls[0]!.body).toBe(JSON.stringify({ name: '回声', tagline: '在线' }));
  });

  it('没有 body 的写操作不设 content-type，method 仍用传入值', async () => {
    const calls = recording();

    await adminApi.clearChat();

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers.has('content-type')).toBe(false);
  });

  it('FormData 原样交给 fetch 且不设 content-type（否则丢 multipart boundary）', async () => {
    const form = new FormData();
    form.append('file', new File(['sticker-bytes'], '开心.png', { type: 'image/png' }), '开心.png');
    const calls = recording({ created: [], failed: [] });

    await adminApi.uploadSticker(form);

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/admin/stickers');
    expect(calls[0]!.body).toBe(form);
    expect(calls[0]!.headers.has('content-type')).toBe(false);
    expect((calls[0]!.body as FormData).get('file')).toBeInstanceOf(File);
    expect(((calls[0]!.body as FormData).get('file') as File).name).toBe('开心.png');
  });

  it('discoverModels 不传 baseUrl 时仍发出空对象 body（而不是省略 body）', async () => {
    const calls = recording({ models: [], source: 'static' });

    await adminApi.discoverModels('chat');

    expect(calls[0]!.url).toBe('/api/admin/models/chat/discover');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe('{}');
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
  });

  it('discoverModels 传了 baseUrl 时把它放进 body', async () => {
    const calls = recording({ models: ['gpt-4o'], source: 'remote' });

    await adminApi.discoverModels('vision', 'https://api.example.com/v1');

    expect(calls[0]!.url).toBe('/api/admin/models/vision/discover');
    expect(calls[0]!.body).toBe(JSON.stringify({ baseUrl: 'https://api.example.com/v1' }));
  });

  it('testModel 只带槽位打 /test，正文是空对象（密钥不出服务器）', async () => {
    const calls = recording({ ok: true, slot: 'chat', provider: 'openai-chat', model: 'gpt-4o', latencyMs: 312, detail: '模型回了 3 个字' });

    const result = await adminApi.testModel('chat');

    expect(calls[0]!.url).toBe('/api/admin/models/chat/test');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe('{}');
    expect(result.latencyMs).toBe(312);
    expect(result.detail).toBe('模型回了 3 个字');
  });

  it('testModel 失败时把服务端写好的失败原因原样抛出来', async () => {
    recording({ error: 'auth_failed', status: 401, message: '鉴权失败（HTTP 401）：密钥不对' }, 502);

    const error = await adminApi.testModel('chat').catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('鉴权失败（HTTP 401）：密钥不对');
    expect((error as ApiError).status).toBe(502);
  });

  it('testWebSearch 只发送提供方和测试查询，不发送密钥', async () => {
    const calls = recording({ ok: true, provider: 'doubao', latencyMs: 88, resultCount: 3 });

    const result = await adminApi.testWebSearch('doubao', 'OpenAI');

    expect(calls[0]!.url).toBe('/api/admin/models/web-search/test');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe(JSON.stringify({ provider: 'doubao', query: 'OpenAI' }));
    expect(result.resultCount).toBe(3);
  });

  it('saveModelPresets 把数组包进 { presets }', async () => {
    const preset: ModelPreset = {
      id: 'p1',
      name: '主力',
      slot: 'chat',
      provider: 'openai-chat',
      model: 'gpt-4o',
      baseUrl: '',
      notes: ''
    };
    const calls = recording({ presets: [preset] });

    await adminApi.saveModelPresets([preset]);

    expect(calls[0]!.url).toBe('/api/admin/model-presets');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.body).toBe(JSON.stringify({ presets: [preset] }));
  });

  it('addModelPreset sends a public preset to the server-side binding endpoint', async () => {
    const preset: ModelPreset = {
      id: 'p1',
      name: '涓诲姏',
      slot: 'chat',
      provider: 'openai-chat',
      model: 'gpt-4o',
      baseUrl: '',
      notes: ''
    };
    const calls = recording({ preset: { ...preset, apiKeyConfigured: true } });

    await adminApi.addModelPreset(preset);

    expect(calls[0]!.url).toBe('/api/admin/model-presets/from-current');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe(JSON.stringify({ preset }));
    expect(calls[0]!.body).not.toContain('apiKey');
  });
});

describe('adminApi 无参端点的 URL 与 method 契约', () => {
  const endpoints: Array<{ name: string; call: () => Promise<unknown>; url: string; method: string }> = [
    { name: 'system', call: () => adminApi.system(), url: '/api/admin/system', method: 'GET' },
    { name: 'capabilities', call: () => adminApi.capabilities(), url: '/api/admin/capabilities', method: 'GET' },
    { name: 'persona', call: () => adminApi.persona(), url: '/api/admin/persona', method: 'GET' },
    { name: 'models', call: () => adminApi.models(), url: '/api/admin/models', method: 'GET' },
    { name: 'stickers', call: () => adminApi.stickers(), url: '/api/admin/stickers', method: 'GET' },
    { name: 'modelPresets', call: () => adminApi.modelPresets(), url: '/api/admin/model-presets', method: 'GET' },
    { name: 'memories', call: () => adminApi.memories(), url: '/api/admin/memories', method: 'GET' },
    { name: 'media', call: () => adminApi.media(), url: '/api/admin/media', method: 'GET' },
    { name: 'errors', call: () => adminApi.errors(), url: '/api/admin/errors', method: 'GET' },
    { name: 'jobs', call: () => adminApi.jobs(), url: '/api/admin/jobs', method: 'GET' },
    { name: 'backups', call: () => adminApi.backups(), url: '/api/admin/backups', method: 'GET' },
    { name: 'clearErrors', call: () => adminApi.clearErrors(), url: '/api/admin/errors', method: 'DELETE' },
    { name: 'clearMemories', call: () => adminApi.clearMemories(), url: '/api/admin/memories/clear', method: 'POST' },
    { name: 'clearChat', call: () => adminApi.clearChat(), url: '/api/admin/chat/clear', method: 'POST' },
    { name: 'createBackup', call: () => adminApi.createBackup(), url: '/api/admin/backups', method: 'POST' }
  ];

  it.each(endpoints)('$name 请求 $method $url', async ({ call, url, method }) => {
    const calls = recording();

    await call();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(url);
    expect(calls[0]!.method).toBe(method);
    expect(calls[0]!.body).toBeUndefined();
  });

  it('errors 与 clearErrors 共用 URL，只靠 method 区分', async () => {
    const calls = recording();

    await adminApi.errors();
    await adminApi.clearErrors();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/admin/errors',
      'DELETE /api/admin/errors'
    ]);
  });

  it('backups 与 createBackup 共用 URL，只靠 method 区分', async () => {
    const calls = recording();

    await adminApi.backups();
    await adminApi.createBackup();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/admin/backups',
      'POST /api/admin/backups'
    ]);
  });

  it('persona 与 updatePersona、models 与 updateModels 共用 URL，只靠 method 区分', async () => {
    const calls = recording();

    await adminApi.persona();
    await adminApi.updatePersona({ name: '回声' });
    await adminApi.models();
    await adminApi.updateModels({ chat: { model: 'gpt-4o' } });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/admin/persona',
      'PUT /api/admin/persona',
      'GET /api/admin/models',
      'PUT /api/admin/models'
    ]);
    expect(calls[3]!.body).toBe(JSON.stringify({ chat: { model: 'gpt-4o' } }));
  });
});

describe('adminApi 路径参数转义', () => {
  const id = 'a b/c?d#e&f';
  const enc = encodeURIComponent(id);
  const paths: Array<{ name: string; call: () => Promise<unknown>; url: string; method: string }> = [
    {
      name: 'updateSticker',
      call: () => adminApi.updateSticker(id, { name: '新名字' }),
      url: `/api/admin/stickers/${enc}`,
      method: 'PATCH'
    },
    { name: 'deleteSticker', call: () => adminApi.deleteSticker(id), url: `/api/admin/stickers/${enc}`, method: 'DELETE' },
    { name: 'deleteMemory', call: () => adminApi.deleteMemory(id), url: `/api/admin/memories/${enc}`, method: 'DELETE' },
    { name: 'deleteMedia', call: () => adminApi.deleteMedia(id), url: `/api/admin/media/${enc}`, method: 'DELETE' },
    {
      name: 'applyModelPreset',
      call: () => adminApi.applyModelPreset(id),
      url: `/api/admin/model-presets/${enc}/apply`,
      method: 'POST'
    },
    { name: 'verifyBackup', call: () => adminApi.verifyBackup(id), url: `/api/admin/backups/${enc}/verify`, method: 'POST' },
    { name: 'restoreBackup', call: () => adminApi.restoreBackup(id), url: `/api/admin/backups/${enc}/restore`, method: 'POST' },
    { name: 'deleteBackup', call: () => adminApi.deleteBackup(id), url: `/api/admin/backups/${enc}`, method: 'DELETE' }
  ];

  it.each(paths)('$name 对路径 id 做 encodeURIComponent', async ({ call, url, method }) => {
    const calls = recording();

    await call();

    expect(calls[0]!.url).toBe(url);
    expect(calls[0]!.method).toBe(method);
    // 未转义的 id 会把 ?/# 变成查询串和片段，路径段也会被 / 截断。
    expect(calls[0]!.url).not.toContain(id);
    expect(calls[0]!.url).not.toContain('?');
    expect(calls[0]!.url).not.toContain('#');
  });

  it('updateSticker 在转义后的路径上仍发送 patch body', async () => {
    const calls = recording({ sticker: { id } });

    await adminApi.updateSticker(id, { enabled: false, tags: ['开心'] });

    expect(calls[0]!.body).toBe(JSON.stringify({ enabled: false, tags: ['开心'] }));
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
  });
});

describe('adminRequest 响应解析与错误', () => {
  it('正常 JSON 响应原样返回解析后的对象', async () => {
    recording({ persona: { id: 'echo', name: '回声' } });

    const result = await adminApi.persona();

    expect(result).toEqual({ persona: { id: 'echo', name: '回声' } });
  });

  it('空响应体返回 null', async () => {
    captureFetch(() => new Response(null, { status: 200 }));

    await expect(adminApi.clearChat()).resolves.toBeNull();
  });

  it('非 JSON 文本不抛解析异常，原样作为结果', async () => {
    captureFetch(() => new Response('plain text', { status: 200 }));

    await expect(adminApi.system()).resolves.toBe('plain text');
  });

  it('错误响应抛 ApiError，并带 status 与解析后的 body', async () => {
    captureFetch(() => json({ message: '令牌无效' }, 403));

    const error = await adminApi.system().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('令牌无效');
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).body).toEqual({ message: '令牌无效' });
  });

  it('错误消息优先 message，其次 error，最后回退到状态码', async () => {
    captureFetch(() => json({ message: '优先这条', error: '不是这条' }, 400));
    await expect(adminApi.system()).rejects.toThrow('优先这条');
    vi.unstubAllGlobals();

    captureFetch(() => json({ error: '只有 error' }, 400));
    await expect(adminApi.system()).rejects.toThrow('只有 error');
    vi.unstubAllGlobals();

    captureFetch(() => json({}, 500));
    await expect(adminApi.system()).rejects.toThrow('request failed (500)');
  });

  it('空错误体也给出带状态码的消息', async () => {
    captureFetch(() => new Response(null, { status: 502 }));

    const error = await adminApi.system().catch((e: unknown) => e);

    expect((error as ApiError).message).toBe('request failed (502)');
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).body).toBeNull();
  });

  it('非 JSON 错误体原样进 ApiError.body，消息回退到状态码', async () => {
    captureFetch(() => new Response('<html>502</html>', { status: 502 }));

    const error = await adminApi.system().catch((e: unknown) => e);

    expect((error as ApiError).body).toBe('<html>502</html>');
    expect((error as ApiError).message).toBe('request failed (502)');
  });

  it('401 会清空本地令牌并通知管理外壳', async () => {
    setAdminToken('admin-secret');
    const unauthorized = vi.fn();
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, unauthorized);
    captureFetch(() => json({ message: 'unauthorized' }, 401));

    await expect(adminApi.system()).rejects.toBeInstanceOf(ApiError);

    expect(getAdminToken()).toBeNull();
    expect(unauthorized).toHaveBeenCalledTimes(1);
    window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, unauthorized);
  });

  it('旧令牌请求晚到的 401 不会注销已经更新的令牌', async () => {
    let respond!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
    const unauthorized = vi.fn();
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, unauthorized);
    setAdminToken('old-secret');

    const pending = adminApi.system();
    setAdminToken('new-secret');
    respond(json({ message: 'old token expired' }, 401));
    await expect(pending).rejects.toBeInstanceOf(ApiError);

    expect(getAdminToken()).toBe('new-secret');
    expect(unauthorized).not.toHaveBeenCalled();
    window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, unauthorized);
  });
});
