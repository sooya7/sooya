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

export type LifePlanStatus = 'planned' | 'active' | 'paused' | 'completed' | 'cancelled' | 'skipped';
export type LifePlanSource = 'routine' | 'generated' | 'admin' | 'conversation';

export interface LifePlanRow {
  id: string;
  title: string;
  kind: string;
  planned_start: string | null;
  planned_end: string | null;
  status: LifePlanStatus;
  source: LifePlanSource;
  priority: number;
  meta_json: string;
  created_at: string;
  updated_at: string;
}

export interface LifePlanInput {
  title: string;
  kind: string;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  status?: LifePlanStatus;
  source?: LifePlanSource;
  priority?: number;
  meta?: Record<string, unknown>;
}

export interface LifeEventRow {
  id: string;
  plan_id: string | null;
  log_id: string | null;
  event_type: string;
  activity: string;
  kind: string;
  description: string;
  mood_before: string | null;
  mood_after: string | null;
  happened_at: string;
  shareable: number;
  shared_at: string | null;
  meta_json: string;
  created_at: string;
}

export interface LifeEventInput {
  planId?: string | null;
  logId?: string | null;
  eventType: string;
  activity: string;
  kind: string;
  description: string;
  moodBefore?: string | null;
  moodAfter?: string | null;
  happenedAt: string;
  shareable?: boolean;
  meta?: Record<string, unknown>;
}

const SHAREABLE_KINDS = new Set(['out', 'play', 'meal', 'chore']);

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
        if (existing.kind !== 'sleep') {
          this.recordEvent({
            logId: row.id,
            eventType: 'activity.completed',
            activity: row.activity,
            kind: row.kind,
            description: `完成了${row.activity}`,
            moodBefore: row.mood,
            moodAfter: input.mood,
            happenedAt: row.ended_at,
            shareable: SHAREABLE_KINDS.has(row.kind)
          });
        }
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
    const logChanges = this.db.prepare(`UPDATE life_log SET shared = 1 WHERE id IN (${holes})`).run(...ids).changes;
    const eventChanges = this.db.prepare(`
      UPDATE life_events SET shared_at = ?
      WHERE shared_at IS NULL AND (id IN (${holes}) OR log_id IN (${holes}))
    `).run(nowIso(), ...ids, ...ids).changes;
    this.db.prepare(`
      UPDATE life_log SET shared = 1
      WHERE id IN (SELECT log_id FROM life_events WHERE id IN (${holes}) AND log_id IS NOT NULL)
    `).run(...ids);
    return logChanges + eventChanges;
  }

  countSharedSince(iso: string): number {
    const events = (this.db.prepare('SELECT COUNT(*) c FROM life_events WHERE shared_at IS NOT NULL AND happened_at > ?')
      .get(iso) as { c: number }).c;
    const legacy = (this.db.prepare(`
      SELECT COUNT(*) c FROM life_log l
      WHERE l.shared = 1 AND l.ended_at > ?
        AND NOT EXISTS (SELECT 1 FROM life_events e WHERE e.log_id = l.id)
    `).get(iso) as { c: number }).c;
    return events + legacy;
  }

  createPlan(input: LifePlanInput): LifePlanRow {
    const ts = nowIso();
    const row: LifePlanRow = {
      id: sortableId('life_plan'),
      title: input.title,
      kind: input.kind,
      planned_start: input.plannedStart ?? null,
      planned_end: input.plannedEnd ?? null,
      status: input.status ?? 'planned',
      source: input.source ?? 'admin',
      priority: input.priority ?? 0,
      meta_json: JSON.stringify(input.meta ?? {}),
      created_at: ts,
      updated_at: ts
    };
    this.db.prepare(`
      INSERT INTO life_plans(id,title,kind,planned_start,planned_end,status,source,priority,meta_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(row.id, row.title, row.kind, row.planned_start, row.planned_end, row.status, row.source, row.priority, row.meta_json, row.created_at, row.updated_at);
    return row;
  }

  listPlans(status?: LifePlanStatus): LifePlanRow[] {
    if (status) return this.db.prepare('SELECT * FROM life_plans WHERE status = ? ORDER BY priority DESC, COALESCE(planned_start, created_at) ASC').all(status) as LifePlanRow[];
    return this.db.prepare(`
      SELECT * FROM life_plans
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
        priority DESC, COALESCE(planned_start, created_at) ASC
    `).all() as LifePlanRow[];
  }

  getPlan(id: string): LifePlanRow | undefined {
    return this.db.prepare('SELECT * FROM life_plans WHERE id = ?').get(id) as LifePlanRow | undefined;
  }

  updatePlan(
    id: string,
    patch: Partial<Pick<LifePlanRow, 'title' | 'kind' | 'planned_start' | 'planned_end' | 'status' | 'priority'>> & { meta?: Record<string, unknown> }
  ): LifePlanRow | undefined {
    const current = this.getPlan(id);
    if (!current) return undefined;
    const next = {
      ...current,
      ...patch,
      meta_json: patch.meta ? JSON.stringify({ ...JSON.parse(current.meta_json), ...patch.meta }) : current.meta_json,
      updated_at: nowIso()
    };
    this.db.prepare(`
      UPDATE life_plans SET title=?, kind=?, planned_start=?, planned_end=?, status=?, priority=?, meta_json=?, updated_at=? WHERE id=?
    `).run(next.title, next.kind, next.planned_start, next.planned_end, next.status, next.priority, next.meta_json, next.updated_at, id);
    return next;
  }

  recordEvent(input: LifeEventInput): LifeEventRow {
    const row: LifeEventRow = {
      id: sortableId('life_event'),
      plan_id: input.planId ?? null,
      log_id: input.logId ?? null,
      event_type: input.eventType,
      activity: input.activity,
      kind: input.kind,
      description: input.description,
      mood_before: input.moodBefore ?? null,
      mood_after: input.moodAfter ?? null,
      happened_at: input.happenedAt,
      shareable: input.shareable ? 1 : 0,
      shared_at: null,
      meta_json: JSON.stringify(input.meta ?? {}),
      created_at: nowIso()
    };
    this.db.prepare(`
      INSERT INTO life_events(id,plan_id,log_id,event_type,activity,kind,description,mood_before,mood_after,happened_at,shareable,shared_at,meta_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)
    `).run(row.id, row.plan_id, row.log_id, row.event_type, row.activity, row.kind, row.description, row.mood_before, row.mood_after, row.happened_at, row.shareable, row.meta_json, row.created_at);
    return row;
  }

  events(limit = 50): LifeEventRow[] {
    return this.db.prepare('SELECT * FROM life_events ORDER BY happened_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as LifeEventRow[];
  }

  unsharedEvents(limit = 5): LifeEventRow[] {
    return this.db.prepare(`
      SELECT * FROM life_events
      WHERE shareable = 1 AND shared_at IS NULL
      ORDER BY happened_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(50, limit))) as LifeEventRow[];
  }

  clearAll(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM life_log').run();
      this.db.prepare('DELETE FROM life_state').run();
      this.db.prepare('DELETE FROM life_events').run();
      this.db.prepare('DELETE FROM life_plans').run();
    })();
  }
}
