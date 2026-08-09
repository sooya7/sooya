import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.cleanup();
  h = null;
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };

async function put(payload: unknown) {
  const res = await h!.app.server.inject({ method: 'PUT', url: '/api/admin/models', headers: ADMIN, payload });
  return { res, body: res.json() as Record<string, any> };
}

const boot = (env: Record<string, string> = {}) =>
  createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token', ...env } });

describe('面板里直接填 API Key', () => {
  it('keeps the typed key even though a generic env var exists', async () => {
    // This is the whole point: with the old precedence the save looked fine and
    // changed nothing, because OPENAI_API_KEY won every time.
    h = await boot({ OPENAI_API_KEY: 'sk-from-env-00000000' });
    await put({ image: { provider: 'openai-images', baseUrl: 'https://api.example.com/v1', model: 'gpt-image-2', apiKey: 'sk-typed-in-panel-1234' } });
    expect(h.app.config.getModels().image.apiKey).toBe('sk-typed-in-panel-1234');
  });

  it('treats an empty key from the panel as an explicit deletion', async () => {
    h = await boot({ OPENAI_API_KEY: 'sk-from-env-00000000' });
    await put({ image: { provider: 'openai-images', baseUrl: 'https://api.example.com/v1', model: 'gpt-image-2', apiKey: '' } });
    expect(h.app.config.getModels().image.apiKey).toBe('');
  });

  it('drops the legacy apiKeyEnv field instead of resolving it at runtime', async () => {
    h = await boot({ SOOYA_IMAGE_API_KEY: 'sk-named-var-9999' });
    await put({ image: { provider: 'openai-images', baseUrl: 'https://api.example.com/v1', model: 'gpt-image-2', apiKey: '', apiKeyEnv: 'SOOYA_IMAGE_API_KEY' } });
    expect(h.app.config.getModels().image.apiKey).toBe('');
    expect(h.app.config.getModels().image).not.toHaveProperty('apiKeyEnv');
  });

  it('never sends the key back to the panel, only whether one exists', async () => {
    h = await boot();
    const { body } = await put({ tts: { provider: 'openai-tts', baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: 'sk-secret-value-4242' } });
    expect(JSON.stringify(body.models)).not.toContain('sk-secret-value-4242');
    expect(body.models.tts.apiKeyConfigured).toBe(true);
    expect(body.models.tts.apiKey).toBeUndefined();
  });

  it('leaves the stored key alone when the panel saves without one', async () => {
    h = await boot();
    await put({ tts: { provider: 'openai-tts', baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: 'sk-first-key-1111' } });
    // The form omits apiKey unless the operator typed a new one.
    await put({ tts: { provider: 'openai-tts', baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'nova' } });
    const tts = h.app.config.getModels().tts;
    expect(tts.apiKey).toBe('sk-first-key-1111');
    expect(tts.voice).toBe('nova');
  });

  it('migrates the environment once and removes the old source marker', async () => {
    h = await boot({ SOOYA_CHAT_API_KEY: 'sk-env-rotated-2222' });
    const models = h.app.config.getModels();
    expect(models.chat.apiKey).toBe('sk-env-rotated-2222');
    expect(models.chat).not.toHaveProperty('configSource');
    expect(models.storageVersion).toBe(2);
  });

  it('survives a reload, so the key really is on disk', async () => {
    h = await boot();
    await put({ tts: { provider: 'openai-tts', baseUrl: 'https://api.example.com/v1', model: 'tts-1', voice: 'alloy', apiKey: 'sk-persisted-7777' } });
    h.app.config.reload();
    expect(h.app.config.getModels().tts.apiKey).toBe('sk-persisted-7777');
  });
});
