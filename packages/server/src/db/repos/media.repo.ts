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
      meta_json: JSON.stringify(input.meta ?? {})
    };
    this.db
      .prepare(
        `INSERT INTO media (id, kind, rel_path, mime, bytes, sha256, width, height, duration, origin, created_at, transcript, meta_json)
         VALUES (@id, @kind, @rel_path, @mime, @bytes, @sha256, @width, @height, @duration, @origin, @created_at, @transcript, @meta_json)`
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
    for (const r of rows) out.set(r.id, r);
    return out;
  }

  list(limit = 50, offset = 0, kind?: MediaRow['kind']): MediaRow[] {
    if (kind) {
      return this.db
        .prepare('SELECT * FROM media WHERE kind = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(kind, limit, offset) as MediaRow[];
    }
    return this.db.prepare('SELECT * FROM media ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as MediaRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM media').get() as { c: number }).c;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM media WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Uploaded media older than `cutoff` that no message part references.
   * Stickers are excluded: they live in the sticker library, not in messages.
   */
  listOrphanUploads(cutoff: string, limit = 500): MediaRow[] {
    return this.db
      .prepare(
        `SELECT m.* FROM media m
          WHERE m.origin = 'upload'
            AND m.kind != 'sticker'
            AND m.created_at < ?
            AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.media_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.media_id = m.id)
          ORDER BY m.created_at LIMIT ?`
      )
      .all(cutoff, limit) as MediaRow[];
  }

  findBySha(sha: string, kind: MediaRow['kind']): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE sha256 = ? AND kind = ? LIMIT 1').get(sha, kind) as
      | MediaRow
      | undefined;
  }

  setTranscript(id: string, transcript: string): void {
    this.db.prepare('UPDATE media SET transcript = ? WHERE id = ?').run(transcript, id);
  }
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
