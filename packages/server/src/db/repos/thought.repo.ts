import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';
import type {
  VisibleThought,
  VisibleThoughtKind,
  VisibleThoughtStatus,
  VisibleThoughtVisibility
} from '../../core/thoughts/types.js';

interface ThoughtRow {
  id: string;
  message_id: string;
  batch_id: string;
  revision: number;
  kind: string;
  text: string;
  visibility: string;
  status: string;
  created_at: string;
}

function toThought(row: ThoughtRow): VisibleThought {
  return {
    id: row.id,
    messageId: row.message_id,
    batchId: row.batch_id,
    revision: row.revision,
    kind: row.kind as VisibleThoughtKind,
    text: row.text,
    visibility: row.visibility as VisibleThoughtVisibility,
    status: row.status as VisibleThoughtStatus,
    createdAt: row.created_at
  };
}

export interface ThoughtCreateInput {
  messageId: string;
  batchId: string;
  revision: number;
  kind: VisibleThoughtKind;
  visibility: VisibleThoughtVisibility;
}

/**
 * Visible thoughts persistence.
 *
 * The `status` transition is the publish barrier for thoughts, exactly like
 * `visible_at` is for replies: a thought only becomes visible when
 * `generating → completed` wins atomically in the database. Anything that
 * moved the status first (cancelled by a newer user message, failed by a
 * model error) refuses the update, so a stale generation can never publish.
 */
export class ThoughtRepo {
  constructor(private readonly db: DbLike) {}

  create(input: ThoughtCreateInput): VisibleThought {
    const row: ThoughtRow = {
      id: sortableId('tht'),
      message_id: input.messageId,
      batch_id: input.batchId,
      revision: input.revision,
      kind: input.kind,
      text: '',
      visibility: input.visibility,
      status: 'generating',
      created_at: nowIso()
    };
    this.db.prepare(
      `INSERT INTO visible_thoughts(id, message_id, batch_id, revision, kind, text, visibility, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(row.id, row.message_id, row.batch_id, row.revision, row.kind, row.text, row.visibility, row.status, row.created_at);
    return toThought(row);
  }

  get(id: string): VisibleThought | undefined {
    const row = this.db.prepare('SELECT * FROM visible_thoughts WHERE id = ?').get(id) as ThoughtRow | undefined;
    return row ? toThought(row) : undefined;
  }

  /** The completed user-visible inner monologue for a message, if any. */
  getUserThought(messageId: string): VisibleThought | undefined {
    const row = this.db.prepare(
      `SELECT * FROM visible_thoughts
       WHERE message_id = ? AND kind = 'inner_monologue' AND visibility = 'user' AND status = 'completed'
       ORDER BY created_at DESC LIMIT 1`
    ).get(messageId) as ThoughtRow | undefined;
    return row ? toThought(row) : undefined;
  }

  /** Latest thought (any kind/status) for a batch revision. */
  getByBatchRevision(batchId: string, revision: number): VisibleThought | undefined {
    const row = this.db.prepare(
      `SELECT * FROM visible_thoughts WHERE batch_id = ? AND revision = ? ORDER BY created_at DESC LIMIT 1`
    ).get(batchId, revision) as ThoughtRow | undefined;
    return row ? toThought(row) : undefined;
  }

  /** All thoughts for a message (admin surface). */
  getByMessage(messageId: string): VisibleThought[] {
    const rows = this.db.prepare(
      `SELECT * FROM visible_thoughts WHERE message_id = ? ORDER BY created_at ASC`
    ).all(messageId) as ThoughtRow[];
    return rows.map(toThought);
  }

  /** Admin listing, optionally scoped to a batch revision. */
  listAdmin(opts: { batchId?: string; revision?: number; limit?: number } = {}): VisibleThought[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    if (opts.batchId !== undefined) {
      const rows = opts.revision !== undefined
        ? this.db.prepare(
            `SELECT * FROM visible_thoughts WHERE batch_id = ? AND revision = ? ORDER BY created_at DESC LIMIT ?`
          ).all(opts.batchId, opts.revision, limit)
        : this.db.prepare(
            `SELECT * FROM visible_thoughts WHERE batch_id = ? ORDER BY created_at DESC LIMIT ?`
          ).all(opts.batchId, limit);
      return (rows as ThoughtRow[]).map(toThought);
    }
    const rows = this.db.prepare(
      `SELECT * FROM visible_thoughts ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as ThoughtRow[];
    return rows.map(toThought);
  }

  /**
   * Publish barrier: `generating → completed` wins only when nothing else
   * moved the thought first (newer user message → cancelled, model failure →
   * failed). Returns false when the status already moved.
   */
  completeThought(id: string, text: string): boolean {
    return this.db.prepare(
      `UPDATE visible_thoughts SET status = 'completed', text = ?
       WHERE id = ? AND status = 'generating'`
    ).run(text.slice(0, 2000), id).changes === 1;
  }

  /** Marks a thought failed (generation error / safety drop). Keeps no text. */
  failThought(id: string): boolean {
    return this.db.prepare(
      `UPDATE visible_thoughts SET status = 'failed', text = ''
       WHERE id = ? AND status = 'generating'`
    ).run(id).changes === 1;
  }

  /** Cancels a single still-generating thought (fenced on the publish barrier). */
  cancelThought(id: string): boolean {
    return this.db.prepare(
      `UPDATE visible_thoughts SET status = 'cancelled', text = ''
       WHERE id = ? AND status = 'generating'`
    ).run(id).changes === 1;
  }

  /**
   * A newer user message landed: every thought that is still generating is
   * cancelled, so a not-yet-published thought can never attach to a reply the
   * user has already moved past. Fenced per row on `status = 'generating'`.
   */
  cancelOpenThoughts(batchId?: string): number {
    const sql = batchId === undefined
      ? `UPDATE visible_thoughts SET status = 'cancelled', text = '' WHERE status = 'generating'`
      : `UPDATE visible_thoughts SET status = 'cancelled', text = '' WHERE status = 'generating' AND batch_id = ?`;
    return this.db.prepare(sql).run(...(batchId === undefined ? [] : [batchId])).changes;
  }

  countGenerating(): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM visible_thoughts WHERE status = 'generating'`).get() as { c: number }).c;
  }
}
