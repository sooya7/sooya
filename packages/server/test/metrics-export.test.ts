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

const METRICS_ENV = {
  METRICS_DASHBOARD_ENABLED: 'true',
  ADMIN_API_TOKEN: 'export-test-token'
};

/**
 * Metrics 导出（完整版 §10）：CSV/JSON 只含指标名与数值，
 * 绝不包含消息正文 / 地址等私人信息；admin 端点形态符合冻结契约。
 */
describe('metrics export (完整版)', () => {
  it('CSV export contains only metric rows, never message text or addresses', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: METRICS_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    // 产生真实 reply/voice 指标（含正文与地址形状的文本）。
    await sendText(harness.app, '晚安，我的地址是北京市朝阳区望京SOHO T1 1501室');
    harness.app.services.metrics.record('life', 'activity_diversity', 3);
    harness.app.services.metrics.record('proactive', 'cancel_reasons', 1);

    const rows = harness.app.services.metrics.exportRows(7);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.category && r.metric && typeof r.sum === 'number')).toBe(true);

    const csv = harness.app.services.metrics.toCsv(rows);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('date,category,metric,count,sum,min,max');
    expect(lines.length - 1).toBe(rows.length);

    // 隐私：导出内容没有任何私人正文 / 地址。
    const serialized = `${csv}${JSON.stringify(rows)}`;
    expect(serialized).not.toContain('晚安');
    expect(serialized).not.toContain('北京市朝阳区');
    expect(serialized).not.toContain('望京');
    expect(serialized).not.toContain('msg_');
  });

  it('escapes category/metric names with commas or quotes in CSV', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: METRICS_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    harness.app.services.metrics.record('reply,"quoted"', 'latency,ms', 7);
    const csv = harness.app.services.metrics.toCsv(harness.app.services.metrics.exportRows(7));
    expect(csv).toContain('"reply,""quoted"""');
    expect(csv).toContain('"latency,ms"');
  });

  it('exposes distributions / release-compare / export through the admin API', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: METRICS_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    await sendText(harness.app, '用语音说晚安');
    harness.app.services.metrics.record('life', 'activity_diversity', 5);

    // 分布统计端点
    const dist = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/metrics/distributions?days=7',
      headers: { 'x-admin-token': 'export-test-token' }
    });
    expect(dist.statusCode).toBe(200);
    const distBody = dist.json() as { distributions: Array<{ category: string; metric: string; p50: number; p95: number }> };
    expect(distBody.distributions.some((d) => d.category === 'life' && d.metric === 'activity_diversity')).toBe(true);

    // 版本对比端点
    const cmp = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/metrics/release-compare?currentDays=7&previousDays=7',
      headers: { 'x-admin-token': 'export-test-token' }
    });
    expect(cmp.statusCode).toBe(200);
    const cmpBody = cmp.json() as { comparison: { current: { from: string; to: string }; previous: { from: string; to: string } } };
    expect(cmpBody.comparison.current.to).toBe('2026-08-08');
    expect(cmpBody.comparison.previous.to).toBe('2026-08-01');

    // JSON 导出端点
    const json = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/metrics/export?format=json&days=7',
      headers: { 'x-admin-token': 'export-test-token' }
    });
    expect(json.statusCode).toBe(200);
    const jsonBody = json.json() as { metrics: Array<{ category: string; metric: string }> };
    expect(jsonBody.metrics.length).toBeGreaterThanOrEqual(1);
    expect(json.headers['content-type']).toContain('application/json');

    // CSV 导出端点
    const csv = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/metrics/export?format=csv&days=7',
      headers: { 'x-admin-token': 'export-test-token' }
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('metrics.csv');
    expect(csv.body).toContain('date,category,metric,count,sum,min,max');

    // 隐私：导出响应不含正文/地址
    expect(`${json.body}${csv.body}`).not.toContain('晚安');
    expect(`${json.body}${csv.body}`).not.toContain('msg_');

    // 未授权被拒绝
    const denied = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/metrics/export?format=csv',
      headers: { 'x-admin-token': 'wrong-token' }
    });
    expect(denied.statusCode).toBe(401);
  });
});
