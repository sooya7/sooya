import type { DbLike } from '../handle.js';
import { nextSeq } from '../index.js';
import { newJobId, newSummaryId, nowIso, randomId } from '../../util/ids.js';
import { CONVERSATION_ID, type StreamEvent, type StreamEventType } from '../../core/types.js';
import { redactSecrets, redactStringSecrets } from '../../util/logger.js';
import { priorityForJob } from '../../core/job-priority.js';

/* ------------------------------- settings -------------------------------- */

export class SettingsRepo {
  constructor(private readonly db: DbLike) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  has(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key) !== undefined;
  }

  set<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), nowIso());
  }

  all(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as Array<{ key: string; value_json: string }>;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value_json);
      } catch {
        out[r.key] = null;
      }
    }
    return out;
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}

/* -------------------------------- summaries ------------------------------- */

export interface SummaryRow {
  id: string;
  conversation_id: string;
  version: number;
  from_seq: number;
  to_seq: number;
  content: string;
  created_at: string;
  model: string | null;
  active: number;
}

export class SummaryRepo {
  constructor(private readonly db: DbLike) {}

  create(input: { fromSeq: number; toSeq: number; content: string; model?: string | null }): SummaryRow {
    const version =
      ((
        this.db.prepare('SELECT COALESCE(MAX(version), 0) v FROM summaries WHERE conversation_id = ?').get(CONVERSATION_ID) as {
          v: number;
        }
      ).v ?? 0) + 1;
    const id = newSummaryId();
    this.db
      .prepare(
        `INSERT INTO summaries(id, conversation_id, version, from_seq, to_seq, content, created_at, model, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(id, CONVERSATION_ID, version, input.fromSeq, input.toSeq, input.content, nowIso(), input.model ?? null);
    return this.db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as SummaryRow;
  }

  /** Highest summarized seq — everything below is already covered. */
  coveredUpTo(): number {
    return (
      this.db
        .prepare('SELECT COALESCE(MAX(to_seq), 0) s FROM summaries WHERE conversation_id = ? AND active = 1')
        .get(CONVERSATION_ID) as { s: number }
    ).s;
  }

  active(limit = 8): SummaryRow[] {
    return this.db
      .prepare('SELECT * FROM summaries WHERE conversation_id = ? AND active = 1 ORDER BY to_seq DESC LIMIT ?')
      .all(CONVERSATION_ID, limit) as SummaryRow[];
  }

  all(): SummaryRow[] {
    return this.db.prepare('SELECT * FROM summaries ORDER BY from_seq').all() as SummaryRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM summaries').get() as { c: number }).c;
  }

  clear(): void {
    this.db.prepare('DELETE FROM summaries').run();
  }
}

/* ---------------------------------- jobs ---------------------------------- */

export interface JobRow {
  id: string;
  type: string;
  payload_json: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  run_after: string | null;
  priority: number;
}

export class JobRepo {
  private readonly jobDefinitions = new Map<string, number>();

  constructor(private readonly db: DbLike) {}

  registerJobDefinition(type: string, maxAttempts: number): void {
    this.jobDefinitions.set(type, maxAttempts);
  }

  enqueue(type: string, payload: Record<string, unknown>, opts: { maxAttempts?: number; runAfter?: string; priority?: number } = {}): JobRow {
    if (this.jobDefinitions.size > 0 && !this.jobDefinitions.has(type)) {
      throw new Error(`unknown job type: ${type}`);
    }
    const id = newJobId();
    const ts = nowIso();
    const priority = Math.max(0, Math.min(100, Math.trunc(opts.priority ?? priorityForJob(type))));
    const maxAttempts = opts.maxAttempts ?? this.jobDefinitions.get(type) ?? 3;
    this.db
      .prepare(
        `INSERT INTO jobs(id, type, payload_json, status, attempts, max_attempts, created_at, updated_at, run_after, priority)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`
      )
      .run(id, type, JSON.stringify(payload), maxAttempts, ts, ts, opts.runAfter ?? null, priority);
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow;
  }

  claimNext(types?: readonly string[], excludeTypes?: readonly string[]): JobRow | undefined {
    if (types && types.length === 0) return undefined;
    const tx = this.db.transaction(() => {
      const clauses = ["status = 'pending'", '(run_after IS NULL OR run_after <= ?)'];
      const params: unknown[] = [nowIso()];
      if (types) {
        clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
        params.push(...types);
      }
      if (excludeTypes && excludeTypes.length > 0) {
        clauses.push(`type NOT IN (${excludeTypes.map(() => '?').join(', ')})`);
        params.push(...excludeTypes);
      }
      const row = this.db
        .prepare(
          `SELECT * FROM jobs WHERE ${clauses.join(' AND ')}
           ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1`
        )
        .get(...params) as JobRow | undefined;
      if (!row) return undefined;
      this.db
        .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
      return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id) as JobRow;
    });
    return tx();
  }

  complete(id: string): void {
    this.db.prepare("UPDATE jobs SET status = 'done', updated_at = ?, last_error = NULL WHERE id = ?").run(nowIso(), id);
  }

  fail(id: string, error: string, opts: { retryable?: boolean } = {}): void {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (!row) return;
    const status = opts.retryable === false || row.attempts >= row.max_attempts ? 'failed' : 'pending';
    const runAfter = status === 'pending' ? new Date(Date.now() + 2000 * row.attempts).toISOString() : null;
    this.db
      .prepare('UPDATE jobs SET status = ?, last_error = ?, updated_at = ?, run_after = ? WHERE id = ?')
      .run(status, error.slice(0, 2000), nowIso(), runAfter, id);
  }

  /** Called at boot: running jobs from a crashed process go back to pending. */
  recoverStuck(): number {
    return this.db
      .prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'")
      .run(nowIso()).changes;
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM jobs WHERE status IN ('pending','running')").get() as { c: number }).c;
  }

  hasActive(type: string): boolean {
    const row = this.db
      .prepare("SELECT 1 present FROM jobs WHERE type = ? AND status IN ('pending','running') LIMIT 1")
      .get(type) as { present: number } | undefined;
    return row?.present === 1;
  }

  list(limit = 50): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as JobRow[];
  }

  purgeDone(keepMs = 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - keepMs).toISOString();
    return this.db.prepare("DELETE FROM jobs WHERE status IN ('done','cancelled') AND updated_at < ?").run(cutoff).changes;
  }
}

/* --------------------------------- events --------------------------------- */

export class EventRepo {
  constructor(private readonly db: DbLike) {}

  append(type: StreamEventType, payload: Record<string, unknown>): StreamEvent {
    const seq = nextSeq(this.db, 'event_seq');
    const id = `evt_${seq.toString(36)}_${randomId(6)}`;
    const createdAt = nowIso();
    this.db
      .prepare('INSERT INTO events(id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, seq, type, JSON.stringify(payload), createdAt);
    return { id, seq, type, createdAt, payload };
  }

  since(seq: number, limit = 500): StreamEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(seq, limit) as Array<{ id: string; seq: number; type: StreamEventType; payload_json: string; created_at: string }>;
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      type: r.type,
      createdAt: r.created_at,
      payload: safeParse(r.payload_json)
    }));
  }

  recent(limit = 50): StreamEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?')
      .all(Math.max(1, Math.min(500, limit))) as Array<{ id: string; seq: number; type: StreamEventType; payload_json: string; created_at: string }>;
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      type: r.type,
      createdAt: r.created_at,
      payload: safeParse(r.payload_json)
    }));
  }

  /**
   * High-water mark of issued event sequence numbers.
   * Read from the counter rather than MAX(seq) so pruning (or clearing) the
   * table never makes the value go backwards — a regressing value would make
   * reconnecting clients replay stale ids and miss real events.
   */
  lastSeq(): number {
    const row = this.db.prepare("SELECT value FROM counters WHERE name = 'event_seq'").get() as { value: number } | undefined;
    return row?.value ?? 0;
  }

  /** Oldest sequence still retained; below this, replay is impossible. */
  oldestSeq(): number {
    return (this.db.prepare('SELECT COALESCE(MIN(seq), 0) s FROM events').get() as { s: number }).s;
  }

  /** Keep the tail only; older events are not needed for catch-up. */
  prune(keep = 2000): number {
    const cutoff = this.lastSeq() - keep;
    if (cutoff <= 0) return 0;
    return this.db.prepare('DELETE FROM events WHERE seq <= ?').run(cutoff).changes;
  }

  clear(): void {
    this.db.prepare('DELETE FROM events').run();
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* -------------------------------- error log ------------------------------- */

export class ErrorLogRepo {
  constructor(private readonly db: DbLike) {}

  /**
   * Records an error. Messages coming from provider adapters can embed request
   * bodies or headers, so both the message and the detail are redacted before
   * they are persisted — the admin API serves this table verbatim.
   */
  add(scope: string, message: string, detail?: unknown): void {
    this.db
      .prepare('INSERT INTO error_log(id, created_at, scope, message, detail) VALUES (?, ?, ?, ?, ?)')
      .run(
        `err_${randomId(14)}`,
        nowIso(),
        scope.slice(0, 80),
        redactStringSecrets(String(message)).slice(0, 1000),
        detail === undefined ? null : redactStringSecrets(JSON.stringify(redactSecrets(detail))).slice(0, 4000)
      );
    // Keep the table bounded.
    this.db
      .prepare('DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY created_at DESC LIMIT 500)')
      .run();
  }

  list(limit = 100): Array<{ id: string; createdAt: string; scope: string; message: string; detail: unknown }> {
    const rows = this.db.prepare('SELECT * FROM error_log ORDER BY created_at DESC LIMIT ?').all(Math.min(limit, 500)) as Array<{
      id: string;
      created_at: string;
      scope: string;
      message: string;
      detail: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      scope: r.scope,
      message: r.message,
      detail: r.detail ? safeParse(r.detail) : null
    }));
  }

  clear(): void {
    this.db.prepare('DELETE FROM error_log').run();
  }
}
