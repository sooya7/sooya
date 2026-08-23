import type { DbLike } from '../db/handle.js';
import { nowIso } from '../util/ids.js';

/** §33: runtime health per (capability, model). */
export interface ProviderHealth {
  capability: string;
  model: string;
  recentSuccessRate: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  consecutiveFailures: number;
  cooldownUntil: string | null;
  lastFailureType: string | null;
}

const RING_SIZE = 50;
/** §33: three consecutive hard failures trip a short cooldown, not a ban. */
const COOLDOWN_AFTER_FAILURES = 3;
const COOLDOWN_MS = 60_000;

interface Ring {
  ok: boolean[];
  latencies: number[];
}

/**
 * Provider health tracker (§33/§34): in-memory latency/success rings for the
 * live process, with consecutive-failure cooldowns persisted so a restart
 * does not hand a crash-looping provider a clean slate. Embeddings are NEVER
 * auto-switched (vector-space mismatch, plan 禁区 6) — the tracker only
 * observes them.
 */
export class ProviderHealthTracker {
  private readonly rings = new Map<string, Ring>();

  constructor(private readonly db?: DbLike) {}

  record(capability: string, model: string, outcome: { ok: boolean; latencyMs: number; failureType?: string }): void {
    const key = `${capability}:${model}`;
    const ring = this.rings.get(key) ?? { ok: [], latencies: [] };
    ring.ok.push(outcome.ok);
    ring.latencies.push(outcome.latencyMs);
    if (ring.ok.length > RING_SIZE) ring.ok.shift();
    if (ring.latencies.length > RING_SIZE) ring.latencies.shift();
    this.rings.set(key, ring);

    if (!this.db) return;
    if (outcome.ok) {
      this.db
        .prepare(
          `UPDATE provider_health SET consecutive_failures = 0, cooldown_until = NULL, last_failure_type = NULL,
             success_count = success_count + 1, updated_at = ?
           WHERE capability = ? AND model = ?`
        )
        .run(nowIso(), capability, model);
    } else {
      const failures = this.consecutiveFailuresOf(capability, model) + 1;
      const cooldown = failures >= COOLDOWN_AFTER_FAILURES ? new Date(Date.now() + COOLDOWN_MS).toISOString() : null;
      this.db
        .prepare(
          `UPDATE provider_health SET consecutive_failures = ?, cooldown_until = COALESCE(?, cooldown_until),
             last_failure_type = ?, failure_count = failure_count + 1, updated_at = ?
           WHERE capability = ? AND model = ?`
        )
        .run(failures, cooldown, outcome.failureType ?? 'unknown', nowIso(), capability, model);
    }
  }

  /** Ensure a row exists so UPDATE-based recording has something to hit. */
  ensure(capability: string, model: string): void {
    if (!this.db) return;
    this.db
      .prepare('INSERT OR IGNORE INTO provider_health(capability, model, updated_at) VALUES (?, ?, ?)')
      .run(capability, model, nowIso());
  }

  inCooldown(capability: string, model: string, now: Date = new Date()): boolean {
    if (!this.db) return false;
    const row = this.db
      .prepare('SELECT cooldown_until FROM provider_health WHERE capability = ? AND model = ?')
      .get(capability, model) as { cooldown_until: string | null } | undefined;
    return Boolean(row?.cooldown_until && Date.parse(row.cooldown_until) > now.getTime());
  }

  health(capability: string, model: string): ProviderHealth {
    const key = `${capability}:${model}`;
    const ring = this.rings.get(key);
    const recent = ring?.ok.slice(-20) ?? [];
    const latencies = (ring?.latencies ?? []).slice().sort((a, b) => a - b);
    const row = this.db
      ? (this.db.prepare('SELECT * FROM provider_health WHERE capability = ? AND model = ?').get(capability, model) as
          | { consecutive_failures: number; cooldown_until: string | null; last_failure_type: string | null }
          | undefined)
      : undefined;
    return {
      capability,
      model,
      recentSuccessRate: recent.length > 0 ? recent.filter(Boolean).length / recent.length : 1,
      p50LatencyMs: latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)]! : null,
      p95LatencyMs: latencies.length > 0 ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]! : null,
      consecutiveFailures: row?.consecutive_failures ?? 0,
      cooldownUntil: row?.cooldown_until ?? null,
      lastFailureType: row?.last_failure_type ?? null
    };
  }

  all(): ProviderHealth[] {
    const seen = new Set<string>();
    for (const key of this.rings.keys()) {
      const [capability, model] = key.split(':');
      if (!capability || !model) continue;
      seen.add(key);
    }
    const rows = this.db
      ? (this.db.prepare('SELECT capability, model FROM provider_health').all() as Array<{ capability: string; model: string }>)
      : [];
    const out: ProviderHealth[] = [];
    for (const row of rows) {
      out.push(this.health(row.capability, row.model));
      seen.add(`${row.capability}:${row.model}`);
    }
    for (const key of seen) {
      if (out.some((h) => `${h.capability}:${h.model}` === key)) continue;
      const [capability, model] = key.split(':');
      if (capability && model) out.push(this.health(capability, model));
    }
    return out;
  }

  private consecutiveFailuresOf(capability: string, model: string): number {
    if (!this.db) return 0;
    const row = this.db
      .prepare('SELECT consecutive_failures FROM provider_health WHERE capability = ? AND model = ?')
      .get(capability, model) as { consecutive_failures: number } | undefined;
    return row?.consecutive_failures ?? 0;
  }
}
