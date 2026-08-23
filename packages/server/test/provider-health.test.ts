import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import { ProviderHealthTracker } from '../src/providers/health.js';

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

function tracker(): { t: ProviderHealthTracker; db: Database.Database } {
  const db = new Database(':memory:');
  open.push(db);
  migrate(db);
  const t = new ProviderHealthTracker(db);
  t.ensure('chat', 'primary-model');
  return { t, db };
}

describe('ProviderHealthTracker (§33)', () => {
  it('tracks success rate and latency percentiles', () => {
    const { t } = tracker();
    for (let i = 0; i < 10; i++) t.record('chat', 'primary-model', { ok: true, latencyMs: 100 + i * 10 });
    t.record('chat', 'primary-model', { ok: false, latencyMs: 500, failureType: 'http_500' });
    const health = t.health('chat', 'primary-model');
    expect(health.recentSuccessRate).toBeCloseTo(10 / 11);
    expect(health.p50LatencyMs).not.toBeNull();
    expect(health.p95LatencyMs).toBeGreaterThanOrEqual(health.p50LatencyMs!);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastFailureType).toBe('http_500');
  });

  it('trips a cooldown after consecutive failures and clears it on success', () => {
    const { t } = tracker();
    for (let i = 0; i < 3; i++) t.record('chat', 'primary-model', { ok: false, latencyMs: 50, failureType: 'timeout' });
    expect(t.inCooldown('chat', 'primary-model')).toBe(true);
    expect(t.health('chat', 'primary-model').cooldownUntil).toBeTruthy();
    t.record('chat', 'primary-model', { ok: true, latencyMs: 50 });
    expect(t.inCooldown('chat', 'primary-model')).toBe(false);
    expect(t.health('chat', 'primary-model').consecutiveFailures).toBe(0);
  });

  it('persists cooldown state across a restart (new tracker, same db)', () => {
    const { t, db } = tracker();
    for (let i = 0; i < 3; i++) t.record('chat', 'primary-model', { ok: false, latencyMs: 50 });
    const revived = new ProviderHealthTracker(db);
    expect(revived.inCooldown('chat', 'primary-model')).toBe(true);
    expect(revived.health('chat', 'primary-model').consecutiveFailures).toBe(3);
  });

  it('exposes per-capability rows for admin observability', () => {
    const { t } = tracker();
    t.ensure('embedding', 'emb-model');
    t.record('embedding', 'emb-model', { ok: true, latencyMs: 20 });
    const all = t.all();
    expect(all.some((h) => h.capability === 'chat' && h.model === 'primary-model')).toBe(true);
    expect(all.some((h) => h.capability === 'embedding' && h.model === 'emb-model')).toBe(true);
  });
});
