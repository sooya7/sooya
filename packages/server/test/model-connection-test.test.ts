import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, type HarnessOptions } from './helpers/harness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };
const boot = (opts: HarnessOptions = {}) =>
  createHarness({ ...opts, env: { ADMIN_API_TOKEN: 'admin-test-token', ...(opts.env ?? {}) } });

async function test(slot: string) {
  const res = await h!.app.server.inject({ method: 'POST', url: `/api/admin/models/${slot}/test`, headers: ADMIN, payload: {} });
  return { res, body: res.json() as Record<string, any> };
}

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

describe('测试连接', () => {
  it('真的打一次接口，成功时回报供应商、模型和这次的耗时', async () => {
    h = await boot({ chat: { script: [['嗯，我在。']] } });
    const { res, body } = await test('chat');
    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.slot).toBe('chat');
    expect(body.provider).toBe('openai-chat');
    expect(body.model).toBe('fake-chat');
    expect(body.detail).toContain('5 个字');
    expect(typeof body.latencyMs).toBe('number');
    // One probe request, deliberately tiny and non-streaming.
    expect(h.state.chatCalls).toHaveLength(1);
    const sent = h.state.chatCalls[0]!.body as { max_tokens?: number; stream?: boolean };
    expect(sent.max_tokens).toBe(16);
    expect(sent.stream).toBe(false);
  });

  it('200 但没有正文时仍算连通，而不是报成连接失败', async () => {
    h = await boot({ chat: { respond: () => json(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] }) } });
    const { res, body } = await test('chat');
    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.detail).toContain('没有返回文本');
  });

  it('把 401 说成鉴权失败，而不是笼统的“测试失败”', async () => {
    h = await boot({ chat: { respond: () => json(401, { error: { message: 'invalid api key' } }) } });
    const { res, body } = await test('chat');
    expect(res.statusCode).toBe(502);
    expect(body.error).toBe('auth_failed');
    expect(body.status).toBe(401);
    expect(body.message).toContain('密钥');
    // Failures are readable later in the panel's error log.
    expect(h.app.repos.errors.list(5).map((row) => row.scope)).toContain('admin.model-test');
  });

  it('其他 4xx 归为“接口拒绝了请求”，指向模型名或参数', async () => {
    h = await boot({ chat: { respond: () => json(404, { error: { message: 'model not found' } }) } });
    const { res, body } = await test('chat');
    expect(res.statusCode).toBe(502);
    expect(body.error).toBe('request_rejected');
    expect(body.status).toBe(404);
    expect(body.message).toContain('模型名');
  });

  it('5xx 归为上游出错，和自己配错区分开', async () => {
    h = await boot({ chat: { respond: () => new Response('boom', { status: 503 }) } });
    const { res, body } = await test('chat');
    expect(res.statusCode).toBe(502);
    expect(body.error).toBe('upstream_error');
    expect(body.status).toBe(503);
  });

  it('连不上时报网络不可达，并带上原始报错', async () => {
    h = await boot({ chat: { chatError: new Error('fetch failed') } });
    const { res, body } = await test('chat');
    expect(res.statusCode).toBe(502);
    expect(body.error).toBe('unreachable');
    expect(body.detail).toContain('fetch failed');
    expect(h.app.repos.errors.list(5).map((row) => row.scope)).toContain('admin.model-test');
  });

  it('没配全的能力是 400 配置缺失，不算连接故障', async () => {
    h = await boot(); // embedding 默认 provider: none
    const { res, body } = await test('embedding');
    expect(res.statusCode).toBe(400);
    expect(body.error).toBe('not_configured');
  });

  it('embedding 与 tts 各按自己最便宜的调用探测', async () => {
    h = await boot({ embedding: 'ok', embeddingDim: 8, tts: 'ok' });
    const embedding = await test('embedding');
    expect(embedding.res.statusCode).toBe(200);
    expect(embedding.body.detail).toContain('8 维向量');
    expect(h.state.embedCalls).toBe(1);

    const tts = await test('tts');
    expect(tts.res.statusCode).toBe(200);
    expect(tts.body.detail).toContain('音频');
    expect(h.state.ttsCalls).toBe(1);
  });

  it('不给出图做自动探测，而是说清为什么', async () => {
    h = await boot({ image: 'ok' });
    const image = await test('image');
    expect(image.res.statusCode).toBe(400);
    expect(image.body.error).toBe('test_unsupported');
    expect(image.body.message).toContain('费用');
    expect(h.state.imageCalls).toBe(0);

    const forced = await h.app.server.inject({
      method: 'POST', url: '/api/admin/models/image/test', headers: ADMIN, payload: { force: true }
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().provider).toBe('openai-images');
    expect(forced.json().detail).toContain('KB');
    expect(h.state.imageCalls).toBe(1);

  });

  it('读图能力没声明支持读图时不给出“通了”的假象', async () => {
    h = await boot();
    await h.app.server.inject({
      method: 'PUT',
      url: '/api/admin/models',
      headers: ADMIN,
      payload: { vision: { provider: 'openai-chat', baseUrl: 'https://fake.example.com/v1', model: 'fake-chat', supportsVision: false } }
    });
    const { res, body } = await test('vision');
    expect(res.statusCode).toBe(400);
    expect(body.error).toBe('vision_not_declared');
    expect(h.state.chatCalls).toHaveLength(0);
  });

  it('读图声明了支持但自己没配全时，报配置缺失而不是回退到聊天模型', async () => {
    h = await boot();
    await h.app.server.inject({
      method: 'PUT',
      url: '/api/admin/models',
      headers: ADMIN,
      // supportsVision 为真，但缺模型名，所以这一槽位自己并没有配好。
      payload: { vision: { provider: 'openai-chat', baseUrl: 'https://fake.example.com/v1', model: '', supportsVision: true } }
    });
    const { res, body } = await test('vision');
    expect(res.statusCode).toBe(400);
    expect(body.error).toBe('not_configured');
    expect(h.state.chatCalls).toHaveLength(0);
  });

  it('拒绝未知槽位，也拒绝没有管理员令牌的调用', async () => {
    h = await boot();
    expect((await test('nope')).res.statusCode).toBe(400);
    const anonymous = await h.app.server.inject({ method: 'POST', url: '/api/admin/models/chat/test', payload: {} });
    expect(anonymous.statusCode).toBe(401);
  });
});
