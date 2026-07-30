import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export interface LifeStateRow {
  activity: string;
  kind: string;
  mood: string;
  started_at: string;
  ends_at: string;
  updated_at: string;
  meta_json: string;
}

export interface LifeLogRow {
  id: string;
  activity: string;
  kind: string;
  mood: string;
  started_at: string;
  ended_at: string;
  shared: number;
  created_at: string;
}

export interface LifeStateInput {
  activity: string;
  kind: string;
  mood: string;
  startedAt: string;
  endsAt: string;
  meta?: Record<string, unknown>;
}

/** The assistant's current activity (one row) plus the history she recounts from. */
export class LifeRepo {
  constructor(private readonly db: DbLike) {}

  current(): LifeStateRow | undefined {
    return this.db.prepare('SELECT * FROM life_state WHERE id = 1').get() as LifeStateRow | undefined;
  }

  /**
   * Replaces the current activity, filing the one it replaces into the log.
   * One transaction, so a crash can never leave a gap in the history or two
   * rows claiming to be "now".
   */
  advance(input: LifeStateInput): { previous: LifeLogRow | null } {
    return this.db.transaction(() => {
      const ts = nowIso();
      const existing = this.current();
      let previous: LifeLogRow | null = null;
      if (existing) {
        const row: LifeLogRow = {
          id: sortableId('life'),
          activity: existing.activity,
          kind: existing.kind,
          mood: existing.mood,
          started_at: existing.started_at,
          // The activity ended when the next one began, not whenever the tick
          // happened to run, so a late tick does not stretch it.
          ended_at: input.startedAt,
          shared: 0,
          created_at: ts
        };
        this.db.prepare(
          'INSERT INTO life_log(id,activity,kind,mood,started_at,ended_at,shared,created_at) VALUES(?,?,?,?,?,?,0,?)'
        ).run(row.id, row.activity, row.kind, row.mood, row.started_at, row.ended_at, row.created_at);
        previous = row;
      }
      this.db.prepare(`
        INSERT INTO life_state(id,activity,kind,mood,started_at,ends_at,updated_at,meta_json)
        VALUES(1,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          activity=excluded.activity, kind=excluded.kind, mood=excluded.mood,
          started_at=excluded.started_at, ends_at=excluded.ends_at,
          updated_at=excluded.updated_at, meta_json=excluded.meta_json
      `).run(
        input.activity, input.kind, input.mood, input.startedAt, input.endsAt, ts,
        JSON.stringify(input.meta ?? {})
      );
      return { previous };
    })();
  }

  /** Most recent finished activities, newest first. */
  recent(limit = 8): LifeLogRow[] {
    return this.db.prepare('SELECT * FROM life_log ORDER BY started_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(100, limit))) as LifeLogRow[];
  }

  since(iso: string, limit = 20): LifeLogRow[] {
    return this.db.prepare('SELECT * FROM life_log WHERE ended_at > ? ORDER BY started_at ASC LIMIT ?')
      .all(iso, Math.max(1, Math.min(100, limit))) as LifeLogRow[];
  }

  /** Candidates for an unprompted message: finished, not yet mentioned. */
  unshared(kinds: string[], limit = 5): LifeLogRow[] {
    if (kinds.length === 0) return [];
    const holes = kinds.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM life_log WHERE shared = 0 AND kind IN (${holes}) ORDER BY ended_at DESC LIMIT ?`
    ).all(...kinds, Math.max(1, Math.min(50, limit))) as LifeLogRow[];
  }

  markShared(ids: string[]): number {
    if (ids.length === 0) return 0;
    const holes = ids.map(() => '?').join(',');
    return this.db.prepare(`UPDATE life_log SET shared = 1 WHERE id IN (${holes})`).run(...ids).changes;
  }

  countSharedSince(iso: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM life_log WHERE shared = 1 AND ended_at > ?')
      .get(iso) as { c: number }).c;
  }

  clearAll(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM life_log').run();
      this.db.prepare('DELETE FROM life_state').run();
    })();
  }
}
