import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

/**
 * P2 metrics: aggregation accuracy, privacy (no text anywhere) and the admin
 * endpoint. Recording is a no-op unless METRICS_DASHBOARD_ENABLED.
 */
describe('metrics (P2)', () => {
  it('is a no-op when the flag is off', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    await sendText(harness.app, '你好');
    expect(harness.app.repos.metrics.categories()).toEqual([]);
    expect(harness.app.services.metrics.aggregates(7)).toEqual([]);
  });

  it('aggregates reply/voice/life/proactive metrics with no message text stored', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      tts: 'ok',
      startWorkers: false,
      env: { METRICS_DASHBOARD_ENABLED: 'true', WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true', ENABLE_LIFE_ENGINE: 'true', ENABLE_LIFE_REACH_OUT: 'true', ADMIN_API_TOKEN: 'admin-test-token' },
      clock: () => localTime('2026-08-08T10:00')
    });

    // Reply + voice metrics via a normal exchange.
    await sendText(harness.app, '用语音说晚安');
    // Life metrics via an activity resolution (location service drives the engine hook).
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    // Proactive blocked metric (open reply batch -> reply_in_progress).
    harness.app.repos.proactive.create({ candidateId: 'cand-m', candidateKind: 'play', candidateActivity: '练琴', requestedMode: 'text', status: 'blocked', detail: {} });

    const categories = harness.app.repos.metrics.categories();
    expect(categories).toContain('reply');
    expect(categories).toContain('voice');

    const aggregates = harness.app.services.metrics.aggregates(7);
    expect(aggregates.some((a) => a.category === 'reply' && a.metric === 'success')).toBe(true);
    expect(aggregates.some((a) => a.category === 'voice' && a.metric.startsWith('mode_'))).toBe(true);
    expect(aggregates.some((a) => a.category === 'voice' && a.metric === 'tts_success')).toBe(true);
    expect(aggregates.some((a) => a.category === 'reply' && a.metric === 'latency_ms' && a.count > 0)).toBe(true);

    // Privacy: the metric tables hold no free text.
    const daily = harness.app.repos.metrics.daily('2026-08-01', '2026-08-08');
    const serialized = JSON.stringify(daily);
    expect(serialized).not.toContain('晚安');
    expect(serialized).not.toContain('msg_');
    for (const row of daily) {
      expect(Object.keys(row).sort()).toEqual(['category', 'count', 'date', 'last_updated', 'metric', 'sum_value']);
    }

    // Admin endpoint exposes the aggregates.
    const res = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/metrics?days=7',
      headers: { 'x-admin-token': 'admin-test-token' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { aggregates: Array<{ category: string; metric: string }> };
    expect(body.aggregates.length).toBeGreaterThanOrEqual(4);
  });
});
