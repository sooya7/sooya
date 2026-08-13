import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };
const withAdmin = () => createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });

async function api(method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) {
  const res = await h!.app.server.inject({
    method,
    url,
    headers: ADMIN,
    ...(payload === undefined ? {} : { payload })
  });
  return { res, body: res.json() as Record<string, any> };
}

const preset = {
  id: 'glm-4-6',
  name: 'GLM-4.6 主聊',
  slot: 'chat',
  provider: 'openai-compatible',
  model: 'glm-4.6',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  notes: '长上下文，日常对话'
};

describe('model preset library', () => {
  it('starts empty and reports the assignable slots', async () => {
    h = await withAdmin();
    const { res, body } = await api('GET', '/api/admin/model-presets');
    expect(res.statusCode).toBe(200);
    expect(body.presets).toEqual([]);
    expect(body.slots).toEqual(['chat', 'vision', 'summary', 'director', 'embedding', 'image', 'tts', 'rerank']);
  });

  it('saves a preset and reads it back', async () => {
    h = await withAdmin();
    const saved = await api('PUT', '/api/admin/model-presets', { presets: [preset] });
    expect(saved.res.statusCode).toBe(200);
    const { body } = await api('GET', '/api/admin/model-presets');
    expect(body.presets).toHaveLength(1);
    expect(body.presets[0]).toMatchObject({ id: 'glm-4-6', name: 'GLM-4.6 主聊', slot: 'chat', model: 'glm-4.6' });
  });

  it('drops legacy STT presets when reading settings', async () => {
    h = await withAdmin();
    h.app.repos.settings.set('models.presets', [preset, { ...preset, id: 'legacy-stt', slot: 'stt' }]);
    const { body } = await api('GET', '/api/admin/model-presets');
    expect(body.presets).toHaveLength(1);
    expect(body.presets[0].id).toBe('glm-4-6');
    expect(h.app.repos.settings.get('models.presets', [])).toEqual([preset]);
  });

  it('rejects a malformed preset and a duplicate id', async () => {
    h = await withAdmin();
    const bad = await api('PUT', '/api/admin/model-presets', { presets: [{ ...preset, id: 'has spaces' }] });
    expect(bad.res.statusCode).toBe(400);
    expect(bad.body.error).toBe('bad_request');

    const dupe = await api('PUT', '/api/admin/model-presets', { presets: [preset, { ...preset, name: '副本' }] });
    expect(dupe.res.statusCode).toBe(400);
    expect(dupe.body.error).toBe('duplicate_id');

    const { body } = await api('GET', '/api/admin/model-presets');
    expect(body.presets).toEqual([]);
  });

  it('applies a preset to its slot and rebuilds the providers', async () => {
    h = await withAdmin();
    await api('PUT', '/api/admin/model-presets', { presets: [preset] });

    const applied = await api('POST', '/api/admin/model-presets/glm-4-6/apply');
    expect(applied.res.statusCode).toBe(200);
    expect(applied.body.applied).toBe('chat');

    const { body } = await api('GET', '/api/admin/models');
    expect(body.models.chat).toMatchObject({
      provider: 'openai-compatible',
      model: 'glm-4.6',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    });
  });

  it('creates a preset from the current server-side key without returning the key', async () => {
    h = await withAdmin();
    const created = await api('POST', '/api/admin/model-presets/from-current', { preset });

    expect(created.res.statusCode).toBe(200);
    expect(created.body.preset).toMatchObject({ id: preset.id, apiKeyBound: true, apiKeyConfigured: true });
    expect(created.body.preset.apiKey).toBeUndefined();
    expect(JSON.stringify(created.body)).not.toContain('sk-test-key-000000');
    expect(h.app.repos.settings.get<any[]>('models.presets', [])[0].apiKey).toBe('sk-test-key-000000');

    h.app.config.setModels({ chat: { apiKey: 'sk-other-key-000000' } });
    const applied = await api('POST', '/api/admin/model-presets/glm-4-6/apply');
    expect(applied.res.statusCode).toBe(200);
    expect(h.app.config.getModels().chat.apiKey).toBe('sk-test-key-000000');
    expect(JSON.stringify(applied.body)).not.toContain('sk-test-key-000000');
  });

  it('distinguishes a bound empty key from a legacy preset with no key binding', async () => {
    h = await withAdmin();
    h.app.config.setModels({ chat: { apiKey: '' } });

    const created = await api('POST', '/api/admin/model-presets/from-current', { preset });
    expect(created.res.statusCode).toBe(200);
    expect(created.body.preset).toMatchObject({ apiKeyBound: true, apiKeyConfigured: false });
    expect(h.app.repos.settings.get<any[]>('models.presets', [])[0]).toHaveProperty('apiKey', '');

    h.app.config.setModels({ chat: { apiKey: 'sk-key-that-must-be-cleared' } });
    await api('POST', '/api/admin/model-presets/glm-4-6/apply');
    expect(h.app.config.getModels().chat.apiKey).toBe('');

    await api('PUT', '/api/admin/model-presets', { presets: [{ ...preset, id: 'legacy-unbound' }] });
    const { body } = await api('GET', '/api/admin/model-presets');
    expect(body.presets[0]).toMatchObject({ apiKeyBound: false, apiKeyConfigured: false });
  });

  it('keeps a bound key when the public preset list is edited', async () => {
    h = await withAdmin();
    await api('POST', '/api/admin/model-presets/from-current', { preset });

    const edited = await api('PUT', '/api/admin/model-presets', {
      presets: [{ ...preset, model: 'glm-4.6-edited' }]
    });
    expect(edited.res.statusCode).toBe(200);

    h.app.config.setModels({ chat: { apiKey: 'sk-other-key-000000' } });
    const applied = await api('POST', '/api/admin/model-presets/glm-4-6/apply');
    expect(applied.res.statusCode).toBe(200);
    expect(h.app.config.getModels().chat.apiKey).toBe('sk-test-key-000000');
    expect(h.app.config.getModels().chat.model).toBe('glm-4.6-edited');
  });

  it('does not carry a bound key across a slot edit', async () => {
    h = await withAdmin();
    await api('POST', '/api/admin/model-presets/from-current', { preset });

    const edited = await api('PUT', '/api/admin/model-presets', {
      presets: [{ ...preset, slot: 'vision', provider: 'openai-compatible' }]
    });
    expect(edited.res.statusCode).toBe(200);

    h.app.config.setModels({ vision: { apiKey: 'sk-vision-current-000000' } });
    const applied = await api('POST', '/api/admin/model-presets/glm-4-6/apply');
    expect(applied.res.statusCode).toBe(200);
    expect(h.app.config.getModels().vision?.apiKey).toBe('sk-vision-current-000000');
  });

  it('clears a TTS environment-key reference when applying a bound key', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token', TTS_LIBRARY_KEY: 'sk-tts-env-000000' } });
    h.app.config.setModels({
      tts: {
        provider: 'openai-tts',
        baseUrl: 'https://fake.example.com/v1',
        apiKey: 'sk-tts-file-000000',
        apiKeyEnv: 'TTS_LIBRARY_KEY',
        model: 'fake-tts'
      }
    });
    const ttsPreset = { ...preset, id: 'tts-preset', slot: 'tts', provider: 'openai-tts', model: 'fake-tts' };
    await api('POST', '/api/admin/model-presets/from-current', { preset: ttsPreset });

    h.app.config.setModels({ tts: { apiKey: 'sk-other-tts-000000' } });
    const applied = await api('POST', '/api/admin/model-presets/tts-preset/apply');
    expect(applied.res.statusCode).toBe(200);
    expect(h.app.config.getModels().tts.apiKey).toBe('sk-tts-env-000000');
    expect(h.app.config.getModels().tts.apiKeyEnv).toBe('');
  });

  it('never stores a secret or an environment variable reference', async () => {
    h = await withAdmin();
    const withSecret = { ...preset, apiKey: 'sk-should-be-dropped', apiKeyEnv: 'LEGACY_API_KEY' };
    await api('PUT', '/api/admin/model-presets', { presets: [withSecret] });
    const { res, body } = await api('GET', '/api/admin/model-presets');
    expect(res.body).not.toContain('sk-should-be-dropped');
    expect(res.body).not.toContain('LEGACY_API_KEY');
    expect(body.presets[0].apiKeyEnv).toBeUndefined();
    expect(body.presets[0].apiKey).toBeUndefined();
  });

  it('reports a slot mismatch instead of corrupting the config', async () => {
    h = await withAdmin();
    await api('PUT', '/api/admin/model-presets', {
      presets: [{ ...preset, id: 'bogus', slot: 'tts', provider: 'not-a-tts-provider' }]
    });
    const applied = await api('POST', '/api/admin/model-presets/bogus/apply');
    expect(applied.res.statusCode).toBe(400);
    expect(applied.body.error).toBe('invalid_preset');
  });

  it('404s an unknown preset and refuses anonymous access', async () => {
    h = await withAdmin();
    const missing = await api('POST', '/api/admin/model-presets/nope/apply');
    expect(missing.res.statusCode).toBe(404);

    const anon = await h.app.server.inject({ method: 'GET', url: '/api/admin/model-presets' });
    expect(anon.statusCode).toBe(401);
  });
});
