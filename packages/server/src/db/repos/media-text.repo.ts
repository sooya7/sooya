import type { DbLike } from '../handle.js';
import { nowIso } from '../../util/ids.js';

export type MediaTextStatus = 'pending' | 'ready' | 'failed' | 'unsupported';

export interface MediaTextRow {
  media_id: string;
  status: MediaTextStatus;
  text: string | null;
  metadata_json: string;
  error: string | null;
  updated_at: string;
}

export interface UpsertMediaTextInput {
  mediaId: string;
  status: MediaTextStatus;
  text?: string | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export class MediaTextRepo {
  constructor(private readonly db: DbLike) {}

  get(mediaId: string): MediaTextRow | undefined {
    return this.db.prepare('SELECT * FROM media_text WHERE media_id = ?').get(mediaId) as MediaTextRow | undefined;
  }

  getMany(mediaIds: string[]): Map<string, MediaTextRow> {
    const out = new Map<string, MediaTextRow>();
    if (mediaIds.length === 0) return out;
    const placeholders = mediaIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM media_text WHERE media_id IN (${placeholders})`).all(...mediaIds) as MediaTextRow[];
    for (const row of rows) out.set(row.media_id, row);
    return out;
  }

  upsert(input: UpsertMediaTextInput): MediaTextRow {
    const row = {
      media_id: input.mediaId,
      status: input.status,
      text: input.text ?? null,
      metadata_json: JSON.stringify(input.metadata ?? {}),
      error: input.error ?? null,
      updated_at: nowIso()
    };
    this.db.prepare(`
      INSERT INTO media_text(media_id, status, text, metadata_json, error, updated_at)
      VALUES (@media_id, @status, @text, @metadata_json, @error, @updated_at)
      ON CONFLICT(media_id) DO UPDATE SET
        status = excluded.status,
        text = excluded.text,
        metadata_json = excluded.metadata_json,
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(row);
    return this.get(input.mediaId)!;
  }
}
