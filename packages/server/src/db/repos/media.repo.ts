import type { DbLike } from '../handle.js';
import type { MediaRef } from '../../core/types.js';
import { newMediaId, nowIso } from '../../util/ids.js';

export interface MediaRow {
  id: string;
  kind: 'image' | 'audio' | 'sticker' | 'file';
  rel_path: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  origin: 'upload' | 'generated' | 'builtin' | 'remote';
  created_at: string;
  transcript: string | null;
  meta_json: string;
  deleted_at: string | null;
  favorite: number;
  tags_json: string;
}

export interface CreateMediaInput {
  id?: string;
  kind: MediaRow['kind'];
  relPath: string;
  mime: string;
  bytes: number;
  sha256: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  origin: MediaRow['origin'];
  transcript?: string | null;
  meta?: Record<string, unknown>;
  tags?: string[];
}

export interface GalleryQuery {
  limit?: number;
  offset?: number;
  kind?: MediaRow['kind'];
  origin?: MediaRow['origin'];
  deleted?: boolean;
  favorite?: boolean;
  search?: string;
  from?: string;
  to?: string;
}

export interface MediaReferences {
  messageParts: number;
  stickers: number;
  worldEntries: number;
  total: number;
}

export class MediaRepo {
  constructor(private readonly db: DbLike) {}

  create(input: CreateMediaInput): MediaRow {
    const id = input.id ?? newMediaId();
    const row: MediaRow = {
      id,
      kind: input.kind,
      rel_path: input.relPath,
      mime: input.mime,
      bytes: input.bytes,
      sha256: input.sha256,
      width: input.width ?? null,
      height: input.height ?? null,
      duration: input.duration ?? null,
      origin: input.origin,
      created_at: nowIso(),
      transcript: input.transcript ?? null,
      meta_json: JSON.stringify(input.meta ?? {}),
      deleted_at: null,
      favorite: 0,
      tags_json: JSON.stringify(input.tags ?? [])
    };
    this.db
      .prepare(
        `INSERT INTO media (id, kind, rel_path, mime, bytes, sha256, width, height, duration, origin, created_at, transcript, meta_json, deleted_at, favorite, tags_json)
         VALUES (@id, @kind, @rel_path, @mime, @bytes, @sha256, @width, @height, @duration, @origin, @created_at, @transcript, @meta_json, @deleted_at, @favorite, @tags_json)`
      )
      .run(row);
    return row;
  }

  get(id: string): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined;
  }

  getMany(ids: string[]): Map<string, MediaRow> {
    const out = new Map<string, MediaRow>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM media WHERE id IN (${placeholders})`).all(...ids) as MediaRow[];
    for (const row of rows) out.set(row.id, row);
    return out;
  }

  list(limit = 50, offset = 0, kind?: MediaRow['kind']): MediaRow[] {
    return this.listGallery({ limit, offset, kind, deleted: false });
  }

  listGallery(input: GalleryQuery = {}): MediaRow[] {
    const { where, values } = galleryWhere(input);
    const limit = Math.max(1, Math.min(200, input.limit ?? 50));
    const offset = Math.max(0, input.offset ?? 0);
    return this.db
      .prepare(`SELECT m.* FROM media m ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.created_at DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as MediaRow[];
  }

  galleryStats(input: Omit<GalleryQuery, 'limit' | 'offset'> = {}): { count: number; bytes: number } {
    const { where, values } = galleryWhere(input);
    return this.db
      .prepare(`SELECT COUNT(*) count, COALESCE(SUM(m.bytes), 0) bytes FROM media m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
      .get(...values) as { count: number; bytes: number };
  }

  count(includeDeleted = true): number {
    const sql = includeDeleted ? 'SELECT COUNT(*) c FROM media' : 'SELECT COUNT(*) c FROM media WHERE deleted_at IS NULL';
    return (this.db.prepare(sql).get() as { c: number }).c;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM media WHERE id = ?').run(id).changes > 0;
  }

  trash(id: string): boolean {
    return this.db.prepare('UPDATE media SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?').run(nowIso(), id).changes > 0;
  }

  restore(id: string): boolean {
    return this.db.prepare('UPDATE media SET deleted_at = NULL WHERE id = ?').run(id).changes > 0;
  }

  setFavorite(id: string, favorite: boolean): boolean {
    return this.db.prepare('UPDATE media SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id).changes > 0;
  }

  setTags(id: string, tags: string[]): boolean {
    const normalized = [...new Set(tags.map((value) => value.trim()).filter(Boolean))].slice(0, 30);
    return this.db.prepare('UPDATE media SET tags_json = ? WHERE id = ?').run(JSON.stringify(normalized), id).changes > 0;
  }

  references(id: string): MediaReferences {
    const messageParts = (this.db.prepare('SELECT COUNT(*) c FROM message_parts WHERE media_id = ?').get(id) as { c: number }).c;
    const stickers = (this.db.prepare('SELECT COUNT(*) c FROM stickers WHERE media_id = ?').get(id) as { c: number }).c;
    const worldEntries = (this.db.prepare('SELECT COUNT(*) c FROM world_entries WHERE active = 1 AND value_json LIKE ?').get(`%${id}%`) as { c: number }).c;
    return { messageParts, stickers, worldEntries, total: messageParts + stickers + worldEntries };
  }

  allRows(): MediaRow[] {
    return this.db.prepare('SELECT * FROM media ORDER BY created_at DESC').all() as MediaRow[];
  }

  listExpiredTrash(cutoff: string, limit = 500): MediaRow[] {
    return this.db.prepare('SELECT * FROM media WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at LIMIT ?').all(cutoff, limit) as MediaRow[];
  }

  listUnreferenced(limit = 500): MediaRow[] {
    return this.db.prepare(`
      SELECT m.* FROM media m
      WHERE m.kind != 'sticker'
        AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.media_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.media_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM world_entries w WHERE w.active = 1 AND w.value_json LIKE '%' || m.id || '%')
      ORDER BY m.created_at LIMIT ?
    `).all(limit) as MediaRow[];
  }

  listOrphanUploads(cutoff: string, limit = 500): MediaRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM media m
          WHERE m.origin = 'upload'
            AND m.kind != 'sticker'
            AND m.created_at < ?
            AND m.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.media_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.media_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM world_entries w WHERE w.active = 1 AND w.value_json LIKE '%' || m.id || '%')
          ORDER BY m.created_at LIMIT ?`
      )
      .all(cutoff, limit) as MediaRow[];
  }

  findBySha(sha: string, kind: MediaRow['kind']): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE sha256 = ? AND kind = ? AND deleted_at IS NULL LIMIT 1').get(sha, kind) as MediaRow | undefined;
  }

  setTranscript(id: string, transcript: string): void {
    this.db.prepare('UPDATE media SET transcript = ? WHERE id = ?').run(transcript, id);
  }
}

function galleryWhere(input: GalleryQuery): { where: string[]; values: unknown[] } {
  const where: string[] = [];
  const values: unknown[] = [];
  if (input.kind) { where.push('m.kind = ?'); values.push(input.kind); }
  if (input.origin) { where.push('m.origin = ?'); values.push(input.origin); }
  if (input.deleted === true) where.push('m.deleted_at IS NOT NULL');
  else if (input.deleted === false || input.deleted === undefined) where.push('m.deleted_at IS NULL');
  if (input.favorite) where.push('m.favorite = 1');
  if (input.from) { where.push('m.created_at >= ?'); values.push(input.from); }
  if (input.to) { where.push('m.created_at <= ?'); values.push(input.to); }
  const search = input.search?.trim();
  if (search) {
    where.push(`(
      m.id LIKE ? ESCAPE '\\' OR m.rel_path LIKE ? ESCAPE '\\' OR m.meta_json LIKE ? ESCAPE '\\' OR m.tags_json LIKE ? ESCAPE '\\' OR
      EXISTS (
        SELECT 1 FROM message_parts p
        LEFT JOIN messages msg ON msg.id = p.message_id
        WHERE p.media_id = m.id AND (p.text LIKE ? ESCAPE '\\' OR p.transcript LIKE ? ESCAPE '\\' OR msg.meta_json LIKE ? ESCAPE '\\')
      )
    )`);
    const q = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    values.push(q, q, q, q, q, q, q);
  }
  return { where, values };
}

export function toMediaRef(row: MediaRow): MediaRef {
  let name: string | null = null;
  try {
    const meta = JSON.parse(row.meta_json) as { name?: string };
    name = meta.name ?? null;
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    duration: row.duration,
    url: `/api/media/${row.id}`,
    name,
    transcript: row.transcript
  };
}

export function mediaMeta(row: MediaRow): { tags: string[]; meta: Record<string, unknown> } {
  let tags: string[] = [];
  let meta: Record<string, unknown> = {};
  try { tags = JSON.parse(row.tags_json) as string[]; } catch { /* ignore */ }
  try { meta = JSON.parse(row.meta_json) as Record<string, unknown>; } catch { /* ignore */ }
  return { tags, meta };
}
