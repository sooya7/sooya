import type { DbLike } from '../handle.js';
import { newStickerId, nowIso } from '../../util/ids.js';
import type { MediaRow } from './media.repo.js';

export interface StickerRow {
  id: string;
  media_id: string;
  name: string;
  tags_json: string;
  emotion: string;
  use_count: number;
  last_used_at: string | null;
  enabled: number;
  created_at: string;
}

export interface Sticker {
  id: string;
  mediaId: string;
  name: string;
  tags: string[];
  emotion: string;
  useCount: number;
  lastUsedAt: string | null;
  enabled: boolean;
  createdAt: string;
  url: string;
  mime?: string;
  /** False when the underlying media file is missing on disk. */
  available?: boolean;
}

export class StickerRepo {
  constructor(private readonly db: DbLike) {}

  create(input: { mediaId: string; name: string; tags: string[]; emotion: string; enabled?: boolean; id?: string }): Sticker {
    const id = input.id ?? newStickerId();
    this.db
      .prepare(
        `INSERT INTO stickers (id, media_id, name, tags_json, emotion, use_count, last_used_at, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`
      )
      .run(id, input.mediaId, input.name, JSON.stringify(input.tags), input.emotion, input.enabled === false ? 0 : 1, nowIso());
    return this.get(id)!;
  }

  get(id: string): Sticker | undefined {
    const row = this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(id) as StickerRow | undefined;
    return row ? this.toSticker(row) : undefined;
  }

  getByName(name: string): Sticker | undefined {
    const row = this.db.prepare('SELECT * FROM stickers WHERE name = ?').get(name) as StickerRow | undefined;
    return row ? this.toSticker(row) : undefined;
  }

  list(opts: { enabledOnly?: boolean } = {}): Sticker[] {
    const sql = opts.enabledOnly
      ? 'SELECT * FROM stickers WHERE enabled = 1 ORDER BY created_at'
      : 'SELECT * FROM stickers ORDER BY created_at';
    return (this.db.prepare(sql).all() as StickerRow[]).map((r) => this.toSticker(r));
  }

  update(id: string, patch: { tags?: string[]; emotion?: string; enabled?: boolean; name?: string }): Sticker | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.tags) (sets.push('tags_json = ?'), values.push(JSON.stringify(patch.tags)));
    if (patch.emotion) (sets.push('emotion = ?'), values.push(patch.emotion));
    if (patch.name) (sets.push('name = ?'), values.push(patch.name));
    if (patch.enabled !== undefined) (sets.push('enabled = ?'), values.push(patch.enabled ? 1 : 0));
    if (sets.length === 0) return this.get(id);
    values.push(id);
    this.db.prepare(`UPDATE stickers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  markUsed(id: string): void {
    this.db.prepare('UPDATE stickers SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(nowIso(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM stickers WHERE id = ?').run(id).changes > 0;
  }

  count(enabledOnly = true): number {
    const sql = enabledOnly ? 'SELECT COUNT(*) c FROM stickers WHERE enabled = 1' : 'SELECT COUNT(*) c FROM stickers';
    return (this.db.prepare(sql).get() as { c: number }).c;
  }

  mediaFor(sticker: Sticker): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE id = ?').get(sticker.mediaId) as MediaRow | undefined;
  }

  private toSticker(row: StickerRow): Sticker {
    let tags: string[] = [];
    try {
      tags = JSON.parse(row.tags_json) as string[];
    } catch {
      /* ignore */
    }
    return {
      id: row.id,
      mediaId: row.media_id,
      name: row.name,
      tags,
      emotion: row.emotion,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      url: `/api/media/${row.media_id}`
    };
  }
}
