import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { DbHandle } from '../src/db/handle.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { MetricsRepo } from '../src/db/repos/metrics.repo.js';
import { MetricsService } from '../src/core/metrics.js';

const tempDbs: Database.Database[] = [];

interface MetricsPair {
  svc: MetricsService;
  repo: MetricsRepo;
}

function makeMetrics(timeZone = 'Asia/Shanghai', clock = () => new Date('2026-08-08T10:00:00+08:00')): MetricsPair {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const m of MIGRATIONS) m.up(db as never);
  tempDbs.push(db);
  const repo = new MetricsRepo(new DbHandle(db));
  const svc = new MetricsService(repo, clock, timeZone);
  svc.setEnabled(true);
  return { svc, repo };
}

afterAll(() => {
  for (const db of tempDbs.splice(0)) db.close();
});

/**
 * Metrics 完整版（§10）：分布统计（min/max/mean/p50/p95）、本地日期归档
 * （LIFE_TIME_ZONE，禁止 UTC 切日）、版本对比。
 */
describe('metrics distribution (完整版)', () => {
  it('computes min/max/mean/p50/p95 from the sampled histogram', () => {
    const { svc } = makeMetrics();
    for (let v = 1; v <= 10; v++) svc.record('reply', 'latency_ms', v);

    const row = svc.distributions(7).find((d) => d.category === 'reply' && d.metric === 'latency_ms')!;
    expect(row).toBeTruthy();
    expect(row.count).toBe(10);
    expect(row.sum).toBe(55);
    expect(row.min).toBe(1);
    expect(row.max).toBe(10);
    expect(row.mean).toBe(5.5);
    expect(row.p50).toBe(5);
    expect(row.p95).toBe(10);
  });

  it('handles duplicate buckets and returns the exact sampled value at the quantile', () => {
    const { svc } = makeMetrics();
    for (let i = 0; i < 10; i++) svc.record('voice', 'tts_latency_ms', 5);
    const row = svc.distributions(7).find((d) => d.category === 'voice')!;
    expect(row.p50).toBe(5);
    expect(row.p95).toBe(5);
    expect(row.min).toBe(5);
    expect(row.max).toBe(5);
  });

  it('merges histogram buckets across local days within the range', () => {
    let clock = () => new Date('2026-08-01T10:00:00+08:00');
    const { svc } = makeMetrics('Asia/Shanghai', () => clock());
    for (const v of [1, 2, 3, 4, 5]) svc.record('reply', 'latency_ms', v);
    clock = () => new Date('2026-08-02T10:00:00+08:00');
    for (const v of [6, 7, 8, 9, 10]) svc.record('reply', 'latency_ms', v);

    const row = svc.distributionsBetween('2026-08-01', '2026-08-02').find((d) => d.metric === 'latency_ms')!;
    expect(row.count).toBe(10);
    expect(row.min).toBe(1);
    expect(row.max).toBe(10);
    expect(row.mean).toBe(5.5);
    expect(row.p50).toBe(5);
    expect(row.p95).toBe(10);
  });

  it('slices days by the LIFE_TIME_ZONE local date, never UTC (cross-day boundary)', () => {
    // 2026-08-08T16:30Z = 北京时间 2026-08-09 00:30 —— UTC 日仍是 08-08，
    // 本地日必须是 08-09（禁止 UTC 切日）。
    const { svc, repo } = makeMetrics('Asia/Shanghai', () => new Date('2026-08-08T16:30:00Z'));
    expect(svc.localDay(new Date('2026-08-08T16:30:00Z'))).toBe('2026-08-09');
    svc.record('reply', 'latency_ms', 42);
    const daily = repo.daily('2026-08-08', '2026-08-09');
    expect(daily).toHaveLength(1);
    expect(daily[0]!.date).toBe('2026-08-09');
    expect(daily[0]!.sum_value).toBe(42);

    // 同一天稍早（本地 23:59 前）仍是 08-08。
    const early = makeMetrics('Asia/Shanghai', () => new Date('2026-08-08T15:29:00Z'));
    expect(early.svc.localDay(new Date('2026-08-08T15:29:00Z'))).toBe('2026-08-08');

    // 另一时区（America/New_York，UTC-4 夏令时）：16:30Z = 12:30 当地，仍是 08-08。
    const ny = makeMetrics('America/New_York', () => new Date('2026-08-08T16:30:00Z'));
    expect(ny.svc.localDay(new Date('2026-08-08T16:30:00Z'))).toBe('2026-08-08');
  });

  it('compares two windows with releaseComparison (failure rate / latency semantics)', () => {
    const { svc, repo } = makeMetrics();
    // 基线窗口（07-24..07-31）：平均延迟 100，失败率 0.1
    for (let i = 0; i < 10; i++) repo.record('reply', 'latency_ms', 100, '2026-07-28');
    repo.record('reply', 'failure', 1, '2026-07-28');
    for (let i = 0; i < 9; i++) repo.record('reply', 'failure', 0, '2026-07-28');
    // 当前窗口（08-01..08-08）：平均延迟 200，失败率 0.3
    for (let i = 0; i < 10; i++) repo.record('reply', 'latency_ms', 200, '2026-08-05');
    repo.record('reply', 'failure', 3, '2026-08-05');
    for (let i = 0; i < 7; i++) repo.record('reply', 'failure', 0, '2026-08-05');

    const cmp = svc.releaseComparison('2026-08-01', '2026-08-08', '2026-07-24', '2026-07-31');
    expect(cmp.current.from).toBe('2026-08-01');
    expect(cmp.current.to).toBe('2026-08-08');
    expect(cmp.previous.from).toBe('2026-07-24');
    expect(cmp.previous.to).toBe('2026-07-31');

    const latency = (aggs: typeof cmp.current.aggregates) => aggs.find((a) => a.metric === 'latency_ms')!;
    expect(latency(cmp.previous.aggregates).sum).toBe(1000);
    expect(latency(cmp.previous.aggregates).count).toBe(10);
    expect(latency(cmp.current.aggregates).sum).toBe(2000);
    expect(latency(cmp.current.aggregates).count).toBe(10);

    const failure = (aggs: typeof cmp.current.aggregates) => aggs.find((a) => a.metric === 'failure')!;
    expect(failure(cmp.previous.aggregates).sum).toBe(1);
    expect(failure(cmp.current.aggregates).sum).toBe(3);
  });

  it('computes default windows with releaseComparisonDays (current N days vs previous N days)', () => {
    const { svc } = makeMetrics('Asia/Shanghai', () => new Date('2026-08-08T10:00:00+08:00'));
    const cmp = svc.releaseComparisonDays(7, 7);
    expect(cmp.current.from).toBe('2026-08-02');
    expect(cmp.current.to).toBe('2026-08-08');
    expect(cmp.previous.from).toBe('2026-07-26');
    expect(cmp.previous.to).toBe('2026-08-01');
  });

  it('returns empty results while the flag is off', () => {
    const db = new Database(':memory:');
    for (const m of MIGRATIONS) m.up(db as never);
    tempDbs.push(db);
    const svc = new MetricsService(new MetricsRepo(new DbHandle(db)));
    expect(svc.distributions(7)).toEqual([]);
    expect(svc.exportRows(7)).toEqual([]);
    const cmp = svc.releaseComparison('2026-08-01', '2026-08-08', '2026-07-24', '2026-07-31');
    expect(cmp.current.aggregates).toEqual([]);
    expect(cmp.previous.aggregates).toEqual([]);
  });
});
