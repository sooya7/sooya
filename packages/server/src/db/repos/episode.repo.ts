import type { DbLike } from '../handle.js';
import { nowIso } from '../../util/ids.js';

export type EpisodeKind = 'conversation' | 'shared_event' | 'project' | 'relationship' | 'life_share' | 'milestone';

export interface EpisodeRow {
  id: string;
  kind: EpisodeKind;
  title: string;
  summary: string;
  started_at: string;
  ended_at: string;
  salience: number;
  emotional_tone: string | null;
  local_date: string;
  closed: number;
  created_at: string;
  updated_at: string;
}

export interface Episode {
  id: string;
  kind: EpisodeKind;
  title: string;
  summary: string;
  startedAt: string;
  endedAt: string;
  salience: number;
  emotionalTone: string | null;
  localDate: string;
  closed: boolean;
  messageIds: string[];
  momentIds: string[];
  commitmentIds: string[];
  relationshipThreadIds: string[];
}

/** Episode = an index of references; bodies stay in their source tables. */
export class EpisodeRepo {
  constructor(private readonly db: DbLike) {}

  open(): EpisodeRow | undefined {
    return this.db.prepare('SELECT * FROM episodes WHERE closed = 0 ORDER BY ended_at DESC LIMIT 1').get() as EpisodeRow | undefined;
  }

  openRows(): EpisodeRow[] {
    return this.db.prepare('SELECT * FROM episodes WHERE closed = 0 ORDER BY ended_at DESC').all() as EpisodeRow[];
  }

  create(input: { kind: EpisodeKind; startedAt: string; localDate: string; title?: string; salience?: number }): EpisodeRow {
    const id = `epi_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO episodes (id, kind, title, summary, started_at, ended_at, salience, local_date, closed, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, input.kind, input.title ?? '', input.startedAt, input.startedAt, input.salience ?? 0.5, input.localDate, ts, ts);
    return this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow;
  }

  extend(id: string, at: string): void {
    this.db.prepare('UPDATE episodes SET ended_at = ?, updated_at = ? WHERE id = ?').run(at, nowIso(), id);
  }

  close(id: string, patch: { title: string; summary: string; emotionalTone?: string | null; endedAt?: string }): void {
    this.db
      .prepare(
        `UPDATE episodes SET title = ?, summary = ?, emotional_tone = COALESCE(?, emotional_tone),
           ended_at = CASE WHEN ? > ended_at THEN ? ELSE ended_at END, closed = 1, updated_at = ? WHERE id = ?`
      )
      .run(patch.title, patch.summary, patch.emotionalTone ?? null, patch.endedAt ?? '', patch.endedAt ?? '', nowIso(), id);
  }

  attachMessage(episodeId: string, messageId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO episode_messages(episode_id, message_id) VALUES (?, ?)').run(episodeId, messageId);
  }

  attachMoment(episodeId: string, momentId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO episode_moments(episode_id, moment_id) VALUES (?, ?)').run(episodeId, momentId);
  }

  attachCommitment(episodeId: string, commitmentId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO episode_commitments(episode_id, commitment_id) VALUES (?, ?)').run(episodeId, commitmentId);
  }

  attachThread(episodeId: string, threadId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO episode_relationship_threads(episode_id, thread_id) VALUES (?, ?)').run(episodeId, threadId);
  }

  lastMessageAt(episodeId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT m.created_at AS at FROM episode_messages em JOIN messages m ON m.id = em.message_id
         WHERE em.episode_id = ? ORDER BY m.created_at DESC LIMIT 1`
      )
      .get(episodeId) as { at: string } | undefined;
    return row?.at ?? null;
  }

  messageIds(episodeId: string): string[] {
    return (
      this.db.prepare('SELECT message_id FROM episode_messages WHERE episode_id = ? ORDER BY rowid').all(episodeId) as Array<{
        message_id: string;
      }>
    ).map((r) => r.message_id);
  }

  listByDateRange(fromDate: string, toDate: string, limit = 100): Episode[] {
    const rows = this.db
      .prepare('SELECT * FROM episodes WHERE local_date BETWEEN ? AND ? ORDER BY started_at DESC LIMIT ?')
      .all(fromDate, toDate, limit) as EpisodeRow[];
    return rows.map((r) => this.toEpisode(r));
  }

  countByDate(date: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM episodes WHERE local_date = ?').get(date) as { c: number }).c;
  }

  get(id: string): Episode | undefined {
    const row = this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow | undefined;
    return row ? this.toEpisode(row) : undefined;
  }

  toEpisode(row: EpisodeRow): Episode {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      salience: row.salience,
      emotionalTone: row.emotional_tone,
      localDate: row.local_date,
      closed: row.closed === 1,
      messageIds: this.messageIds(row.id),
      momentIds: (this.db.prepare('SELECT moment_id FROM episode_moments WHERE episode_id = ?').all(row.id) as Array<{ moment_id: string }>).map((r) => r.moment_id),
      commitmentIds: (this.db.prepare('SELECT commitment_id FROM episode_commitments WHERE episode_id = ?').all(row.id) as Array<{ commitment_id: string }>).map((r) => r.commitment_id),
      relationshipThreadIds: (this.db.prepare('SELECT thread_id FROM episode_relationship_threads WHERE episode_id = ?').all(row.id) as Array<{ thread_id: string }>).map((r) => r.thread_id)
    };
  }
}
