import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

/**
 * P1-1: feature flags must actually roll back — with each flag off the system
 * still boots, replies and produces a valid API contract. No half-new-half-old
 * state, no crash, and the DB schema (already at v18) must not break the old
 * code paths.
 */
const FLAG_CASES: Array<[string, string]> = [
  ['REPLY_INTERRUPTIBLE_GENERATION', 'false'],
  ['VOICE_V2_ENABLED', 'false'],
  ['VOICE_INDEPENDENT_SCRIPT_ENABLED', 'false'],
  ['VOICE_NATURALNESS_GUARD_ENABLED', 'false'],
  ['VOICE_ADVANCED_DELIVERY_ENABLED', 'false'],
  ['VOICE_AUTO_COMPLEMENT_ENABLED', 'false'],
  ['VOICE_READ_ALOUD_ENABLED', 'false'],
  ['ENABLE_LIFE_V2', 'false']
];

describe('feature flag rollback (P1-1)', () => {
  it.each(FLAG_CASES)('with %s=false the system still boots and replies', async (flag, value) => {
    harness = await createHarness({ tts: 'ok', env: { [flag]: value } });
    const { res, body } = await sendText(harness.app, '你好');
    expect(res.statusCode).toBe(200);
    expect(body.reply?.status).toBe('sent');
    expect(body.reply?.content.length).toBeGreaterThan(0);
    expect(body.outcome).toBeDefined();
    expect(harness.app.repos.replyBatches).toBeTruthy();
  });

  it('VOICE_V2_ENABLED=false keeps the legacy read-back voice path working', async () => {
    harness = await createHarness({ tts: 'ok', env: { VOICE_V2_ENABLED: 'false' }, chat: { script: [['晚安[[voice]]']] } });
    const { res, body } = await sendText(harness.app, '用语音说');
    expect(res.statusCode).toBe(200);
    const audio = body.reply?.content.find((p: { type: string }) => p.type === 'audio');
    expect(audio?.status).toBe('sent');
    expect(audio?.transcript).toContain('晚安');
  });

  it('VOICE_READ_ALOUD_ENABLED=false ignores read-aloud intent and replies in text', async () => {
    harness = await createHarness({ tts: 'ok', env: { VOICE_READ_ALOUD_ENABLED: 'false' } });
    const { res, body } = await sendText(harness.app, '读出来');
    expect(res.statusCode).toBe(200);
    expect(body.reply?.content.some((p: { type: string }) => p.type === 'text')).toBe(true);
  });

  it('ENABLE_LIFE_V2=false keeps the Admin life panel contract', async () => {
    harness = await createHarness({
      env: { ENABLE_LIFE_V2: 'false', ENABLE_LIFE_ENGINE: 'true', ADMIN_API_TOKEN: 'test-admin-token' },
      clock: () => new Date('2026-07-31T12:00:00+08:00')
    });
    const res = await harness.app.server.inject({ method: 'GET', url: '/api/admin/life', headers: { 'x-admin-token': 'test-admin-token' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.snapshot.activity).toBe('string');
    expect(body.log).toBeDefined();
  });
});
