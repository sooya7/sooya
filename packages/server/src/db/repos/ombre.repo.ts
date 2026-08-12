import type { DbLike } from '../handle.js';
import { nowIso } from '../../util/ids.js';

export type OmbreCommitState = 'running' | 'completed' | 'uncertain' | 'failed' | 'skipped';

export interface OmbreCommitRow {
  batch_id: string;
  revision: number;
  state: OmbreCommitState;
  started_at: string | null;
  completed_at: string | null;
  detail_json: string;
}

export class OmbreCommitRepo {
  constructor(private readonly db: DbLike) {}

  get(batchId: string, revision: number): OmbreCommitRow | undefined {
    return this.db.prepare('SELECT * FROM ombre_commits WHERE batch_id = ? AND revision = ?').get(batchId, revision) as OmbreCommitRow | undefined;
  }

  start(batchId: string, revision: number, detail: Record<string, unknown> = {}): OmbreCommitRow {
    const now = nowIso();
    this.db.prepare(
      `INSERT INTO ombre_commits(batch_id, revision, state, started_at, completed_at, detail_json)
       VALUES (?, ?, 'running', ?, NULL, ?)
       ON CONFLICT(batch_id, revision) DO UPDATE SET
         state = CASE WHEN ombre_commits.state = 'completed' THEN ombre_commits.state ELSE 'running' END,
         started_at = COALESCE(ombre_commits.started_at, excluded.started_at),
         detail_json = excluded.detail_json`
    ).run(batchId, revision, now, JSON.stringify(detail));
    return this.get(batchId, revision)!;
  }

  mark(batchId: string, revision: number, state: OmbreCommitState, detail: Record<string, unknown> = {}): OmbreCommitRow {
    const completedAt = state === 'completed' || state === 'failed' || state === 'skipped' ? nowIso() : null;
    this.db.prepare(
      `INSERT INTO ombre_commits(batch_id, revision, state, started_at, completed_at, detail_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(batch_id, revision) DO UPDATE SET
         state = excluded.state,
         completed_at = excluded.completed_at,
         detail_json = excluded.detail_json`
    ).run(batchId, revision, state, nowIso(), completedAt, JSON.stringify(detail));
    return this.get(batchId, revision)!;
  }

  list(limit = 100): OmbreCommitRow[] {
    return this.db.prepare('SELECT * FROM ombre_commits ORDER BY COALESCE(started_at, completed_at) DESC LIMIT ?').all(Math.max(1, Math.min(1000, limit))) as OmbreCommitRow[];
  }

  latestCompleted(): OmbreCommitRow | undefined {
    return this.db.prepare("SELECT * FROM ombre_commits WHERE state = 'completed' ORDER BY completed_at DESC LIMIT 1").get() as OmbreCommitRow | undefined;
  }

  hasCompletedSince(iso: string): boolean {
    const row = this.db
      .prepare("SELECT 1 present FROM ombre_commits WHERE state = 'completed' AND completed_at >= ? LIMIT 1")
      .get(iso) as { present: number } | undefined;
    return row?.present === 1;
  }
}
