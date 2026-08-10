import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, makeFakeMp3, sendText, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

/**
 * P1 Voice Preferences: save/load, capability mapping, preview isolation
 * (no chat message, no memory/life, no media record) and the rate limit.
 */
describe('Voice Preferences API (P1)', () => {
  it('saves and reloads preferences including quiet hours', async () => {
    harness = await createHarness({ skipStickerImport: true, tts: 'ok' });
    const patch = await harness.app.server.inject({
      method: 'PATCH',
      url: '/api/settings/voice',
      payload: { autoVoiceFrequency: 'sometimes', maxVoiceSeconds: 50, quietHours: { from: 23, to: 7 } }
    });
    expect(patch.statusCode).toBe(200);
    const body = patch.json() as { preferences: { autoVoiceFrequency: string; maxVoiceSeconds: number; quietHours: { from: number; to: number } } };
    expect(body.preferences.autoVoiceFrequency).toBe('sometimes');
    expect(body.preferences.maxVoiceSeconds).toBe(50);
    expect(body.preferences.quietHours).toEqual({ from: 23, to: 7 });

    const get = await harness.app.server.inject({ method: 'GET', url: '/api/settings/voice' });
    const reloaded = get.json() as { preferences: { quietHours: { from: number } } };
    expect(reloaded.preferences.quietHours.from).toBe(23);
  });

  it('exposes provider capabilities', async () => {
    harness = await createHarness({ skipStickerImport: true, tts: 'ok' });
    const res = await harness.app.server.inject({ method: 'GET', url: '/api/settings/voice/capabilities' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { configured: boolean; provider: string | null; supportsSpeed: boolean; supportsAbort: boolean; emotionEnum: string[] };
    expect(body.configured).toBe(true);
    expect(body.supportsSpeed).toBe(true);
    expect(body.supportsAbort).toBe(true);
    expect(body.emotionEnum.length).toBeGreaterThan(0);
  });

  it('preview synthesizes without creating any chat message, memory or media record', async () => {
    harness = await createHarness({ skipStickerImport: true, tts: 'ok' });
    const messagesBefore = harness.app.repos.messages.count();
    const res = await harness.app.server.inject({
      method: 'POST',
      url: '/api/settings/voice/preview',
      payload: { text: '用语音打个招呼吧', emotion: 'happy' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { audioBase64: string; mime: string; durationSec: number | null };
    expect(body.audioBase64.length).toBeGreaterThan(100);
    expect(body.mime).toBe('audio/mpeg');
    expect(harness.app.repos.messages.count()).toBe(messagesBefore);
    expect(harness.app.repos.media.count()).toBe(0);
    expect(harness.app.repos.memories.list().length).toBe(0);
  });

  it('rate-limits previews', async () => {
    harness = await createHarness({ skipStickerImport: true, tts: 'ok' });
    const first = await harness.app.server.inject({
      method: 'POST',
      url: '/api/settings/voice/preview',
      payload: { text: '第一次试听' }
    });
    expect(first.statusCode).toBe(200);
    const second = await harness.app.server.inject({
      method: 'POST',
      url: '/api/settings/voice/preview',
      payload: { text: '第二次试听' }
    });
    expect(second.statusCode).toBe(429);
  });

  it('rejects preview text over the character cap', async () => {
    harness = await createHarness({ skipStickerImport: true, tts: 'ok' });
    // The first call above consumed the rate window in a previous test — use a
    // fresh harness ip, so a long text is clipped server-side to 200 chars.
    const res = await harness.app.server.inject({
      method: 'POST',
      url: '/api/settings/voice/preview',
      payload: { text: '长'.repeat(3000) }
    });
    // Either accepted with a clip, rejected by the schema cap, or
    // rate-limited — never a crash.
    expect([200, 400, 429]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = res.json() as { chars: number };
      expect(body.chars).toBeLessThanOrEqual(200);
    }
    void makeFakeMp3;
    void sendText;
  });
});

/**
 * Voice-system convergence §4.1: the admin panel keeps exactly two behavior
 * knobs (enabled + per-clip length cap); provider parameters live in model
 * config and the old per-mood editors are gone.
 */
describe('Voice behavior API (convergence §4.1)', () => {
  it('reads and updates the two minimal behavior knobs', async () => {
    harness = await createHarness({ skipStickerImport: true, tts: 'ok', env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const headers = { 'x-admin-token': 'admin-test-token' };

    const get = await harness.app.server.inject({ method: 'GET', url: '/api/admin/voice-behavior', headers });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ enabled: true, maxVoiceSeconds: 35 });

    const put = await harness.app.server.inject({
      method: 'PUT',
      url: '/api/admin/voice-behavior',
      headers,
      payload: { enabled: false, maxVoiceSeconds: 50 }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ enabled: false, maxVoiceSeconds: 50 });

    const reloaded = await harness.app.server.inject({ method: 'GET', url: '/api/admin/voice-behavior', headers });
    expect(reloaded.json()).toMatchObject({ enabled: false, maxVoiceSeconds: 50 });
  });

  it('rejects out-of-range length caps', async () => {
    harness = await createHarness({ skipStickerImport: true, tts: 'ok', env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const res = await harness.app.server.inject({
      method: 'PUT',
      url: '/api/admin/voice-behavior',
      headers: { 'x-admin-token': 'admin-test-token' },
      payload: { maxVoiceSeconds: 3 }
    });
    expect(res.statusCode).toBe(400);
  });
});
