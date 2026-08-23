import type { DbLike } from '../handle.js';
import {
  ARCHIVE_SALIENCE,
  COOLING_SALIENCE,
  SALIENCE_HALFLIFE_DAYS,
  type RelationshipThread,
  type RelationshipThreadKind,
  type ThreadStatus
} from '../../core/relationship/types.js';
import { bufferToFloats, floatsToBuffer, normalizeMemoryText } from './memory.repo.js';
import { randomId, nowIso } from '../../util/ids.js';

export interface RelationshipThreadRow {
  id: string;
  kind: RelationshipThreadKind;
  title: string;
  normalized_title: string;
  summary: string;
  status: ThreadStatus;
  salience: number;
  confidence: number;
  first_message_id: string | null;
  last_message_id: string | null;
  linked_commitment_id: string | null;
  reopen_count: number;
  embedding: Buffer | null;
  embedding_dim: number | null;
  embedding_model: string | null;
  opened_at: string;
  last_touched_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

const DAY_MS = 86_400_000;
/** Threads a new signal may join: open, or cooling (one good touch re-wakes). */
const MATCHABLE = "('open','cooling')";

export function normalizeThreadTitle(title: string): string {
  return normalizeMemoryText(title);
}

export class RelationshipThreadRepo {
  constructor(private readonly db: DbLike) {}

  create(input: {
    kind: RelationshipThreadKind;
    title: string;
    summary?: string;
    salience?: number;
    confidence?: number;
    messageId?: string | null;
    linkedCommitmentId?: string | null;
    embedding?: number[];
    embeddingModel?: string;
  }): RelationshipThread {
    const id = `rel_${randomId(14)}`;
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO relationship_threads
          (id, kind, title, normalized_title, summary, status, salience, confidence,
           first_message_id, last_message_id, linked_commitment_id, reopen_count,
           opened_at, last_touched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        input.title,
        normalizeThreadTitle(input.title),
        input.summary ?? input.title,
        input.salience ?? 0.7,
        input.confidence ?? 0.6,
        input.messageId ?? null,
        input.messageId ?? null,
        input.linkedCommitmentId ?? null,
        ts,
        ts,
        ts,
        ts
      );
    if (input.embedding) this.setEmbedding(id, input.embedding, input.embeddingModel ?? 'unknown');
    return this.get(id)!;
  }

  /** §4 touch: refresh recency, boost salience, adopt the newest summary. */
  touch(id: string, opts: { summary?: string; messageId?: string | null; at?: string } = {}): RelationshipThread | undefined {
    const row = this.rowById(id);
    if (!row) return undefined;
    const ts = opts.at ?? nowIso();
    const salience = Math.min(1, Math.max(row.salience, 0.7) + 0.15);
    this.db
      .prepare(
        `UPDATE relationship_threads
           SET salience = ?, summary = COALESCE(?, summary), last_message_id = COALESCE(?, last_message_id),
               last_touched_at = ?, updated_at = ?,
               status = CASE WHEN status IN ('cooling','resolved','archived') THEN 'open' ELSE status END,
               resolved_at = CASE WHEN status IN ('resolved','archived') THEN NULL ELSE resolved_at END,
               reopen_count = CASE WHEN status IN ('resolved','archived') THEN reopen_count + 1 ELSE reopen_count END
         WHERE id = ?`
      )
      .run(salience, opts.summary ?? null, opts.messageId ?? null, ts, ts, id);
    return this.get(id);
  }

  resolve(id: string, at: string = nowIso()): RelationshipThread | undefined {
    const row = this.rowById(id);
    if (!row) return undefined;
    if (row.status === 'resolved' || row.status === 'archived') return this.get(id);
    this.db
      .prepare("UPDATE relationship_threads SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?")
      .run(at, at, id);
    return this.get(id);
  }

  archive(id: string, at: string = nowIso()): boolean {
    return this.db
      .prepare("UPDATE relationship_threads SET status = 'archived', updated_at = ? WHERE id = ? AND status <> 'resolved'")
      .run(at, id).changes > 0;
  }

  setEmbedding(id: string, vector: number[], model: string): void {
    this.db
      .prepare('UPDATE relationship_threads SET embedding = ?, embedding_dim = ?, embedding_model = ? WHERE id = ?')
      .run(floatsToBuffer(vector), vector.length, model, id);
  }

  /** Threads a new signal may join, freshest first. */
  matchable(): RelationshipThreadRow[] {
    return this.db
      .prepare(`SELECT * FROM relationship_threads WHERE status IN ${MATCHABLE} ORDER BY last_touched_at DESC LIMIT 50`)
      .all() as RelationshipThreadRow[];
  }

  /** Context-eligible threads (§6): open and salient enough, salience-ordered. */
  contextThreads(limit = 5): RelationshipThread[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM relationship_threads WHERE status = 'open' AND salience >= ?
           ORDER BY salience DESC, last_touched_at DESC LIMIT ?`
        )
        .all(COOLING_SALIENCE, limit) as RelationshipThreadRow[]
    ).map((r) => this.toRecord(r));
  }

  list(opts: { status?: ThreadStatus; limit?: number } = {}): RelationshipThread[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = opts.status
      ? (this.db.prepare('SELECT * FROM relationship_threads WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(opts.status, limit) as RelationshipThreadRow[])
      : (this.db.prepare('SELECT * FROM relationship_threads ORDER BY updated_at DESC LIMIT ?').all(limit) as RelationshipThreadRow[]);
    return rows.map((r) => this.toRecord(r));
  }

  /**
   * §4 time-driven decay. Runs from maintenance; every untouched thread decays
   * by its own half-life, crossing cooling and then archive thresholds.
   */
  decaySweep(now: Date = new Date()): { cooling: number; archived: number } {
    const rows = this.db
      .prepare(`SELECT id, kind, salience, last_touched_at, status FROM relationship_threads WHERE status IN ('open','cooling')`)
      .all() as Array<Pick<RelationshipThreadRow, 'id' | 'kind' | 'salience' | 'last_touched_at' | 'status'>>;
    let cooling = 0;
    let archived = 0;
    const ts = now.toISOString();
    for (const row of rows) {
      const elapsedDays = (now.getTime() - Date.parse(row.last_touched_at)) / DAY_MS;
      if (elapsedDays <= 0) continue;
      const halflife = SALIENCE_HALFLIFE_DAYS[row.kind];
      const decayed = row.salience * Math.pow(0.5, elapsedDays / halflife);
      if (decayed < ARCHIVE_SALIENCE) {
        archived += this.db
          .prepare("UPDATE relationship_threads SET salience = ?, status = 'archived', updated_at = ? WHERE id = ?")
          .run(decayed, ts, row.id).changes;
      } else if (decayed < COOLING_SALIENCE && row.status === 'open') {
        cooling += this.db
          .prepare("UPDATE relationship_threads SET salience = ?, status = 'cooling', updated_at = ? WHERE id = ?")
          .run(decayed, ts, row.id).changes;
      } else {
        this.db.prepare('UPDATE relationship_threads SET salience = ?, updated_at = ? WHERE id = ?').run(decayed, ts, row.id);
      }
    }
    return { cooling, archived };
  }

  vectorOf(row: RelationshipThreadRow): number[] | null {
    return row.embedding ? bufferToFloats(row.embedding) : null;
  }

  rowById(id: string): RelationshipThreadRow | undefined {
    return this.db.prepare('SELECT * FROM relationship_threads WHERE id = ?').get(id) as RelationshipThreadRow | undefined;
  }

  get(id: string): RelationshipThread | undefined {
    const row = this.rowById(id);
    return row ? this.toRecord(row) : undefined;
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) c FROM relationship_threads GROUP BY status').all() as Array<{
      status: string;
      c: number;
    }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  toRecord(row: RelationshipThreadRow): RelationshipThread {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      normalizedTitle: row.normalized_title,
      summary: row.summary,
      status: row.status,
      salience: row.salience,
      confidence: row.confidence,
      firstMessageId: row.first_message_id,
      lastMessageId: row.last_message_id,
      linkedCommitmentId: row.linked_commitment_id,
      reopenCount: row.reopen_count,
      openedAt: row.opened_at,
      lastTouchedAt: row.last_touched_at,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
