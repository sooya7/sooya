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

async function discover(slot: string, payload: unknown = {}) {
  const res = await h!.app.server.inject({ method: 'POST', url: `/api/admin/models/${slot}/discover`, headers: ADMIN, payload });
  return { res, body: res.json() as Record<string, any> };
}

describe('拉取模型列表', () => {
  it('returns the endpoint model ids, sorted and de-duplicated', async () => {
    h = await boot({ discover: { payload: { data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }] } } });
    const { res, body } = await discover('chat');
    expect(res.statusCode).toBe(200);
    expect(body.models).toEqual(['alpha', 'zeta']);
    expect(body.source).toBe('https://fake.example.com/v1/models');
  });

  it('accepts the shapes endpoints actually return: bare strings and a models key', async () => {
    h = await boot({ discover: { payload: { models: ['b', 'a'] } } });
    expect((await discover('chat')).body.models).toEqual(['a', 'b']);
  });

  it('pulls for the address being typed, before it is saved', async () => {
    h = await boot();
    const { body } = await discover('chat', { baseUrl: 'https://other.example.com/v2/' });
    // Trailing slash trimmed, /models appended once.
    expect(body.source).toBe('https://other.example.com/v2/models');
  });

  it('does not append /models twice when the address already ends in it', async () => {
    h = await boot();
    expect((await discover('chat', { baseUrl: 'https://fake.example.com/v1/models' })).body.source)
      .toBe('https://fake.example.com/v1/models');
  });

  it('says plainly that a vendor protocol has no model list, instead of failing obscurely', async () => {
    h = await boot();
    await h.app.server.inject({
      method: 'PUT',
      url: '/api/admin/models',
      headers: ADMIN,
      payload: { tts: { provider: 'volc-tts', baseUrl: 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', voice: 'v', model: '' } }
    });
    const { res, body } = await discover('tts');
    expect(res.statusCode).toBe(400);
    expect(body.error).toBe('discovery_unsupported');
    expect(body.message).toContain('手填');
  });

  it('refuses an unknown slot and an unconfigured address', async () => {
    h = await boot();
    expect((await discover('nope')).res.statusCode).toBe(400);
  });

  it('reports an upstream failure as 502 rather than pretending the list is empty', async () => {
    h = await boot({ discover: { status: 401, payload: { error: 'nope' } } });
    const { res, body } = await discover('chat');
    expect(res.statusCode).toBe(502);
    expect(body.error).toBe('discovery_failed');
    expect(body.message).toContain('401');
  });

  it('reports a network error as 502 and logs it where errors are read', async () => {
    h = await boot({ discover: 'network-error' });
    const { res, body } = await discover('chat');
    expect(res.statusCode).toBe(502);
    expect(body.error).toBe('discovery_failed');
    expect(h.app.repos.errors.list(5).map((row) => row.scope)).toContain('admin.discover');
  });

  it('treats a well-formed but empty list as a failure, not as "no models exist"', async () => {
    h = await boot({ discover: { payload: { data: [] } } });
    const { res, body } = await discover('chat');
    expect(res.statusCode).toBe(502);
    expect(body.error).toBe('discovery_empty');
  });

  it('is closed to callers without the admin token', async () => {
    h = await boot();
    const res = await h.app.server.inject({ method: 'POST', url: '/api/admin/models/chat/discover', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
