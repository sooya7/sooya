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
      expect(Object.keys(row).sort()).toEqual(['category', 'count', 'date', 'last_updated', 'max_value', 'metric', 'min_value', 'sum_value']);
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

  it('archives by the injected LIFE_TIME_ZONE, not UTC and not a constructor default', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { METRICS_DASHBOARD_ENABLED: 'true', LIFE_TIME_ZONE: 'Asia/Shanghai' },
      clock: () => new Date('2026-08-08T16:30:00.000Z') // 16:30 UTC = 次日 00:30 (+08)
    });
    harness.app.services.metrics.record('reply', 'success', 1);
    const rows = harness.app.repos.metrics.daily('2026-08-08', '2026-08-09');
    // 16:30Z 在 Asia/Shanghai 是 08-09 00:30 → 归档到本地次日。
    expect(rows.some((r) => r.date === '2026-08-09' && r.metric === 'success' && r.sum_value === 1)).toBe(true);
    expect(rows.some((r) => r.date === '2026-08-08')).toBe(false);
  });
});
