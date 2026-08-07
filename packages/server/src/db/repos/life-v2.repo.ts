import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export interface LifeVitalsRow {
  energy: number;
  hunger: number;
  stress: number;
  social_need: number;
  loneliness: number;
  curiosity: number;
  comfort: number;
  focus: number;
  sleep_debt: number;
  updated_at: string;
  meta_json: string;
}

export interface LifeDayThemeRow {
  id: string;
  local_date: string;
  theme: string;
  tone_tags_json: string;
  source_factors_json: string;
  created_at: string;
}

export interface LifeThreadRow {
  id: string;
  title: string;
  category: string;
  status: 'open' | 'paused' | 'resolved' | 'abandoned';
  progress: number;
  importance: number;
  heat: number;
  started_at: string;
  updated_at: string;
  last_advanced_at: string | null;
  next_actions_json: string;
  meta_json: string;
}

export interface LifeActivityUsageRow {
  activity_id: string;
  last_used_at: string | null;
  use_count_7d: number;
  use_count_30d: number;
  consecutive_days: number;
  semantic_tags_json: string;
  recent_outcomes_json: string;
  updated_at: string;
}

export interface LifeShareCandidateRow {
  id: string;
  source_type: 'event' | 'plan' | 'thread' | 'mood' | 'follow_up';
  source_id: string;
  novelty: number;
  relevance_to_user: number;
  emotional_value: number;
  urgency: number;
  repetition_penalty: number;
  status: 'pending' | 'shared' | 'expired' | 'suppressed';
  created_at: string;
  expires_at: string;
  shared_at: string | null;
  meta_json: string;
}

export class LifeV2Repo {
  constructor(private readonly db: DbLike) {}

  // ---- vitals ----

  getVitals(): LifeVitalsRow | undefined {
    return this.db.prepare('SELECT * FROM life_vitals WHERE id = 1').get() as LifeVitalsRow | undefined;
  }

  upsertVitals(v: Omit<LifeVitalsRow, 'updated_at'> & { updated_at?: string }): void {
    const ts = v.updated_at ?? nowIso();
    this.db.prepare(`
      INSERT INTO life_vitals(id, energy, hunger, stress, social_need, loneliness, curiosity, comfort, focus, sleep_debt, updated_at, meta_json)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        energy=excluded.energy, hunger=excluded.hunger, stress=excluded.stress,
        social_need=excluded.social_need, loneliness=excluded.loneliness,
        curiosity=excluded.curiosity, comfort=excluded.comfort, focus=excluded.focus,
        sleep_debt=excluded.sleep_debt, updated_at=excluded.updated_at, meta_json=excluded.meta_json
    `).run(v.energy, v.hunger, v.stress, v.social_need, v.loneliness, v.curiosity, v.comfort, v.focus, v.sleep_debt, ts, v.meta_json ?? '{}');
  }

  // ---- day themes ----

  themeFor(localDate: string): LifeDayThemeRow | undefined {
    return this.db.prepare('SELECT * FROM life_day_themes WHERE local_date = ?').get(localDate) as LifeDayThemeRow | undefined;
  }

  recentThemes(limit = 14): LifeDayThemeRow[] {
    return this.db.prepare('SELECT * FROM life_day_themes ORDER BY local_date DESC LIMIT ?').all(limit) as LifeDayThemeRow[];
  }

  saveTheme(input: { localDate: string; theme: string; toneTags: string[]; sourceFactors: string[] }): LifeDayThemeRow {
    const row: LifeDayThemeRow = {
      id: sortableId('theme'),
      local_date: input.localDate,
      theme: input.theme,
      tone_tags_json: JSON.stringify(input.toneTags),
      source_factors_json: JSON.stringify(input.sourceFactors),
      created_at: nowIso()
    };
    this.db.prepare(
      `INSERT INTO life_day_themes(id, local_date, theme, tone_tags_json, source_factors_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(local_date) DO UPDATE SET theme=excluded.theme, tone_tags_json=excluded.tone_tags_json, source_factors_json=excluded.source_factors_json`
    ).run(row.id, row.local_date, row.theme, row.tone_tags_json, row.source_factors_json, row.created_at);
    return row;
  }

  // ---- threads ----

  threads(status?: string): LifeThreadRow[] {
    if (status) return this.db.prepare('SELECT * FROM life_threads WHERE status = ? ORDER BY heat DESC, updated_at DESC').all(status) as LifeThreadRow[];
    return this.db.prepare('SELECT * FROM life_threads ORDER BY heat DESC, updated_at DESC LIMIT 50').all() as LifeThreadRow[];
  }

  getThread(id: string): LifeThreadRow | undefined {
    return this.db.prepare('SELECT * FROM life_threads WHERE id = ?').get(id) as LifeThreadRow | undefined;
  }

  saveThread(input: {
    id?: string;
    title: string;
    category: string;
    status?: LifeThreadRow['status'];
    progress?: number;
    importance?: number;
    heat?: number;
    nextActions?: string[];
    meta?: Record<string, unknown>;
  }): LifeThreadRow {
    const existing = input.id ? this.getThread(input.id) : undefined;
    const row: LifeThreadRow = existing
      ? {
          ...existing,
          title: input.title ?? existing.title,
          category: input.category ?? existing.category,
          status: input.status ?? existing.status,
          progress: input.progress ?? existing.progress,
          importance: input.importance ?? existing.importance,
          heat: input.heat ?? existing.heat,
          next_actions_json: JSON.stringify(input.nextActions ?? JSON.parse(existing.next_actions_json)),
          meta_json: JSON.stringify({ ...JSON.parse(existing.meta_json), ...(input.meta ?? {}) }),
          updated_at: nowIso(),
          last_advanced_at: input.status ? nowIso() : existing.last_advanced_at
        }
      : {
          id: sortableId('thread'),
          title: input.title,
          category: input.category,
          status: input.status ?? 'open',
          progress: input.progress ?? 0,
          importance: input.importance ?? 0.5,
          heat: input.heat ?? 0.3,
          started_at: nowIso(),
          updated_at: nowIso(),
          last_advanced_at: null,
          next_actions_json: JSON.stringify(input.nextActions ?? []),
          meta_json: JSON.stringify(input.meta ?? {})
        };
    this.db.prepare(`
      INSERT INTO life_threads(id, title, category, status, progress, importance, heat, started_at, updated_at, last_advanced_at, next_actions_json, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, category=excluded.category, status=excluded.status,
        progress=excluded.progress, importance=excluded.importance, heat=excluded.heat,
        updated_at=excluded.updated_at, last_advanced_at=excluded.last_advanced_at,
        next_actions_json=excluded.next_actions_json, meta_json=excluded.meta_json
    `).run(row.id, row.title, row.category, row.status, row.progress, row.importance, row.heat, row.started_at, row.updated_at, row.last_advanced_at, row.next_actions_json, row.meta_json);
    return row;
  }

  // ---- activity usage ----

  getUsage(activityId: string): LifeActivityUsageRow | undefined {
    return this.db.prepare('SELECT * FROM life_activity_usage WHERE activity_id = ?').get(activityId) as LifeActivityUsageRow | undefined;
  }

  recordUsage(input: {
    activityId: string;
    tags: string[];
    outcomeTags: string[];
    usedAt: string;
  }): void {
    const existing = this.getUsage(input.activityId);
    const ts = input.usedAt;
    const dayOf = (iso: string) => iso.slice(0, 10);
    const usedDay = dayOf(ts);
    const lastDay = existing?.last_used_at ? dayOf(existing.last_used_at) : null;
    const consecutiveDays = existing && lastDay === usedDay ? existing.consecutive_days : existing && lastDay === prevDay(usedDay) ? existing.consecutive_days + 1 : 1;
    const prev7 = existing?.last_used_at ? daysAgo(existing.last_used_at, ts, 7) : 0;
    const prev30 = existing?.last_used_at ? daysAgo(existing.last_used_at, ts, 30) : 0;
    const outcomes = existing
      ? [...JSON.parse(existing.recent_outcomes_json).slice(0, 8), ...input.outcomeTags.slice(0, 3)]
      : [...input.outcomeTags];
    this.db.prepare(`
      INSERT INTO life_activity_usage(activity_id, last_used_at, use_count_7d, use_count_30d, consecutive_days, semantic_tags_json, recent_outcomes_json, updated_at)
      VALUES (?, ?, 1, 1, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        last_used_at=excluded.last_used_at,
        use_count_7d=CASE WHEN julianday(excluded.last_used_at) - julianday(life_activity_usage.last_used_at) > 7 THEN 1 ELSE life_activity_usage.use_count_7d + 1 END,
        use_count_30d=CASE WHEN julianday(excluded.last_used_at) - julianday(life_activity_usage.last_used_at) > 30 THEN 1 ELSE life_activity_usage.use_count_30d + 1 END,
        consecutive_days=excluded.consecutive_days,
        semantic_tags_json=excluded.semantic_tags_json,
        recent_outcomes_json=excluded.recent_outcomes_json,
        updated_at=excluded.updated_at
    `).run(input.activityId, ts, consecutiveDays, JSON.stringify([...new Set([...(existing ? JSON.parse(existing.semantic_tags_json) : []), ...input.tags])].slice(0, 12)), JSON.stringify(outcomes.slice(0, 12)), ts);
  }

  /** Most recently used activities (for semantic anti-repeat). */
  recentActivityUsage(limit: number): LifeActivityUsageRow[] {
    return this.db.prepare('SELECT * FROM life_activity_usage ORDER BY last_used_at DESC LIMIT ?').all(Math.max(1, Math.min(30, limit))) as LifeActivityUsageRow[];
  }

  // ---- share candidates ----

  shareCandidates(status?: string, limit = 20): LifeShareCandidateRow[] {
    if (status) return this.db.prepare('SELECT * FROM life_share_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit) as LifeShareCandidateRow[];
    return this.db.prepare('SELECT * FROM life_share_candidates ORDER BY created_at DESC LIMIT ?').all(limit) as LifeShareCandidateRow[];
  }

  pendingCandidates(): LifeShareCandidateRow[] {
    return this.db.prepare(
      `SELECT * FROM life_share_candidates WHERE status = 'pending' AND expires_at > ? ORDER BY (novelty + relevance_to_user + emotional_value + urgency - repetition_penalty) DESC LIMIT 10`
    ).all(nowIso()) as LifeShareCandidateRow[];
  }

  addShareCandidate(input: {
    sourceType: LifeShareCandidateRow['source_type'];
    sourceId: string;
    novelty: number;
    relevanceToUser: number;
    emotionalValue: number;
    urgency: number;
    repetitionPenalty: number;
    expiresAt: string;
    meta?: Record<string, unknown>;
  }): LifeShareCandidateRow {
    const row: LifeShareCandidateRow = {
      id: sortableId('share'),
      source_type: input.sourceType,
      source_id: input.sourceId,
      novelty: input.novelty,
      relevance_to_user: input.relevanceToUser,
      emotional_value: input.emotionalValue,
      urgency: input.urgency,
      repetition_penalty: input.repetitionPenalty,
      status: 'pending',
      created_at: nowIso(),
      expires_at: input.expiresAt,
      shared_at: null,
      meta_json: JSON.stringify(input.meta ?? {})
    };
    this.db.prepare(`
      INSERT INTO life_share_candidates(id, source_type, source_id, novelty, relevance_to_user, emotional_value, urgency, repetition_penalty, status, created_at, expires_at, shared_at, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?)
    `).run(row.id, row.source_type, row.source_id, row.novelty, row.relevance_to_user, row.emotional_value, row.urgency, row.repetition_penalty, row.created_at, row.expires_at, row.meta_json);
    return row;
  }

  updateShareCandidate(id: string, patch: Partial<Pick<LifeShareCandidateRow, 'status' | 'shared_at'>>): void {
    this.db.prepare('UPDATE life_share_candidates SET status = COALESCE(?, status), shared_at = COALESCE(?, shared_at) WHERE id = ?')
      .run(patch.status ?? null, patch.shared_at ?? null, id);
  }

  /** Expire stale pending candidates. */
  expireShareCandidates(): number {
    return this.db.prepare(
      "UPDATE life_share_candidates SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?"
    ).run(nowIso()).changes;
  }

  markSharedBySource(sourceType: string, sourceId: string): void {
    this.db.prepare(
      "UPDATE life_share_candidates SET status = 'shared', shared_at = ? WHERE source_type = ? AND source_id = ? AND status = 'pending'"
    ).run(nowIso(), sourceType, sourceId);
  }
}

function prevDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function daysAgo(lastIso: string, nowIsoStr: string, windowDays: number): number {
  const diffDays = (Date.parse(nowIsoStr) - Date.parse(lastIso)) / 86_400_000;
  return diffDays <= windowDays ? 1 : 0;
}
