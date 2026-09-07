import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export type VideoTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type VideoTaskMode = 'text' | 'image';

export const VIDEO_TASK_TERMINAL: ReadonlySet<VideoTaskStatus> = new Set(['succeeded', 'failed', 'cancelled']);

export interface VideoTaskRow {
  id: string;
  mode: VideoTaskMode;
  prompt: string;
  status: VideoTaskStatus;
  provider: string;
  model: string;
  params_json: string;
  source_media_id: string | null;
  remote_id: string | null;
  progress: number | null;
  attempts: number;
  media_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CreateVideoTaskInput {
  mode: VideoTaskMode;
  prompt: string;
  provider: string;
  model: string;
  params?: Record<string, unknown>;
  sourceMediaId?: string | null;
}

export interface VideoTaskPatch {
  status?: VideoTaskStatus;
  remoteId?: string | null;
  progress?: number | null;
  attempts?: number;
  mediaId?: string | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface VideoTaskListQuery {
  limit?: number;
  offset?: number;
  status?: VideoTaskStatus;
}

export const newVideoTaskId = () => sortableId('vid');

export class VideoTaskRepo {
  constructor(private readonly db: DbLike) {}

  create(input: CreateVideoTaskInput): VideoTaskRow {
    const id = newVideoTaskId();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO video_tasks (id, mode, prompt, status, provider, model, params_json, source_media_id, remote_id, progress, attempts, media_id, error, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, ?, ?, NULL, NULL)`
      )
      .run(id, input.mode, input.prompt, input.provider, input.model, JSON.stringify(input.params ?? {}), input.sourceMediaId ?? null, ts, ts);
    return this.get(id)!;
  }

  get(id: string): VideoTaskRow | undefined {
    return this.db.prepare('SELECT * FROM video_tasks WHERE id = ?').get(id) as VideoTaskRow | undefined;
  }

  update(id: string, patch: VideoTaskPatch): VideoTaskRow | undefined {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [nowIso()];
    const push = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.remoteId !== undefined) push('remote_id', patch.remoteId);
    if (patch.progress !== undefined) push('progress', patch.progress);
    if (patch.attempts !== undefined) push('attempts', patch.attempts);
    if (patch.mediaId !== undefined) push('media_id', patch.mediaId);
    if (patch.error !== undefined) push('error', patch.error);
    if (patch.startedAt !== undefined) push('started_at', patch.startedAt);
    if (patch.completedAt !== undefined) push('completed_at', patch.completedAt);
    params.push(id);
    this.db.prepare(`UPDATE video_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  list(query: VideoTaskListQuery = {}): VideoTaskRow[] {
    const limit = Math.min(200, Math.max(1, Math.trunc(query.limit ?? 50)));
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));
    if (query.status) {
      return this.db
        .prepare('SELECT * FROM video_tasks WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
        .all(query.status, limit, offset) as VideoTaskRow[];
    }
    return this.db
      .prepare('SELECT * FROM video_tasks ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as VideoTaskRow[];
  }

  count(status?: VideoTaskStatus): number {
    const row = status
      ? (this.db.prepare('SELECT COUNT(*) AS n FROM video_tasks WHERE status = ?').get(status) as { n: number })
      : (this.db.prepare('SELECT COUNT(*) AS n FROM video_tasks').get() as { n: number });
    return row.n;
  }

  /** Tasks still owed a result: what the API caller is waiting on. */
  countActive(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM video_tasks WHERE status IN ('queued','running')").get() as { n: number }).n;
  }

  listActive(): VideoTaskRow[] {
    return this.db.prepare("SELECT * FROM video_tasks WHERE status IN ('queued','running') ORDER BY created_at ASC").all() as VideoTaskRow[];
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM video_tasks WHERE id = ?').run(id).changes > 0;
  }

  /** Media rows that video tasks still point at; the storage sweeper must keep them. */
  referencedMediaIds(): Set<string> {
    const rows = this.db
      .prepare('SELECT media_id, source_media_id FROM video_tasks WHERE media_id IS NOT NULL OR source_media_id IS NOT NULL')
      .all() as Array<{ media_id: string | null; source_media_id: string | null }>;
    const out = new Set<string>();
    for (const row of rows) {
      if (row.media_id) out.add(row.media_id);
      if (row.source_media_id) out.add(row.source_media_id);
    }
    return out;
  }
}

export function videoTaskParams(row: VideoTaskRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.params_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
