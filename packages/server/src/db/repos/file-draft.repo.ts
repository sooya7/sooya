import type { DbLike } from '../handle.js';
import { nowIso } from '../../util/ids.js';

export interface FileDraftRow {
  name: string;
  media_id: string;
  origin: 'written' | 'received';
  editable: number;
  version: number;
  updated_at: string;
}

/** Latest version of each named file (see migration 49). */
export class FileDraftRepo {
  constructor(private readonly db: DbLike) {}

  get(name: string): FileDraftRow | undefined {
    return this.db.prepare('SELECT * FROM file_drafts WHERE name = ?').get(name) as FileDraftRow | undefined;
  }

  list(limit = 50): FileDraftRow[] {
    return this.db.prepare('SELECT * FROM file_drafts ORDER BY updated_at DESC LIMIT ?').all(limit) as FileDraftRow[];
  }

  /** Points `name` at a new media row; returns the media id it replaced, if any. */
  upsert(input: { name: string; mediaId: string; origin: FileDraftRow['origin']; editable: boolean }): string | null {
    const previous = this.get(input.name);
    const now = nowIso();
    if (previous) {
      this.db.prepare(
        'UPDATE file_drafts SET media_id = ?, origin = ?, editable = ?, version = version + 1, updated_at = ? WHERE name = ?'
      ).run(input.mediaId, input.origin, input.editable ? 1 : 0, now, input.name);
      return previous.media_id === input.mediaId ? null : previous.media_id;
    }
    this.db.prepare(
      'INSERT INTO file_drafts(name, media_id, origin, editable, version, updated_at) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(input.name, input.mediaId, input.origin, input.editable ? 1 : 0, now);
    return null;
  }

  expiredBefore(cutoffIso: string, limit = 200): FileDraftRow[] {
    return this.db.prepare('SELECT * FROM file_drafts WHERE updated_at < ? ORDER BY updated_at ASC LIMIT ?').all(cutoffIso, limit) as FileDraftRow[];
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM file_drafts WHERE name = ?').run(name);
  }
}
