import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export type ReplyBatchStatus =
  | 'collecting'
  | 'queued'
  | 'generating'
  | 'publishing'
  | 'completed'
  | 'superseded'
  | 'failed'
  | 'cancelled';

export interface ReplyBatchRow {
  id: string;
  conversation_id: string;
  status: ReplyBatchStatus;
  trigger_message_id: string;
  assistant_message_id: string | null;
  opened_at: string;
  due_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  meta_json: string;
  revision: number;
  last_message_at: string | null;
  generation_started_at: string | null;
  publish_started_at: string | null;
  visible_at: string | null;
  retry_count: number;
  interrupted_count: number;
  superseded_at: string | null;
  failure_code: string | null;
}

export type AppendAction = 'created' | 'appended' | 'interrupt' | 'next_batch';

export interface AppendOrCreateResult {
  batch: ReplyBatchRow;
  action: AppendAction;
  revision: number;
}

export interface GenerationAuditInput {
  batchId: string;
  revision: number;
  attempt: number;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  interruptionReason?: string | null;
  errorCode?: string | null;
  durationMs?: number | null;
  firstTokenMs?: number | null;
  visibleMs?: number | null;
}

export class ReplyBatchRepo {
  constructor(private readonly db: DbLike) {}

  /**
   * Admission for a new user message. One transaction decides whether the
   * message joins the open batch, interrupts the hidden generation, or opens a
   * next batch, so a concurrent publish can never race the decision.
   *
   * `dueAt` is the debounce deadline for the *next* generation; `interruptDueAt`
   * is the earlier deadline used when a hidden generation was interrupted.
   */
  appendOrCreateMessage(messageId: string, dueAt: string, interruptDueAt: string): AppendOrCreateResult {
    const existingMembership = this.db.prepare(
      `SELECT b.* FROM reply_batches b
       JOIN reply_batch_messages bm ON bm.batch_id = b.id
       WHERE bm.message_id = ?`
    ).get(messageId) as ReplyBatchRow | undefined;
    if (existingMembership) {
      // Duplicate client message: never bumps the revision, never re-interrupts.
      return { batch: existingMembership, action: 'appended', revision: existingMembership.revision };
    }

    const open = this.openBatch();
    const ts = nowIso();
    if (!open) {
      const id = sortableId('rb');
      this.db.prepare(
        `INSERT INTO reply_batches(
           id, conversation_id, status, trigger_message_id, opened_at, due_at,
           revision, last_message_at)
         VALUES (?, 'main', 'collecting', ?, ?, ?, 1, ?)`
      ).run(id, messageId, ts, dueAt, ts);
      const batch = this.get(id)!;
      this.addMessageToBatch(batch.id, messageId);
      return { batch, action: 'created', revision: 1 };
    }

    if (open.status === 'collecting' || open.status === 'queued') {
      const batch = this.db.prepare(
        `UPDATE reply_batches
         SET revision = revision + 1,
             trigger_message_id = ?,
             last_message_at = ?,
             due_at = ?,
             status = 'collecting',
             retry_count = 0,
             failure_code = NULL,
             last_error = NULL
         WHERE id = ? AND status IN ('collecting','queued') AND visible_at IS NULL`
      ).run(messageId, ts, dueAt, open.id);
      if (batch.changes !== 1) {
        // Lost the race (e.g. another worker claimed it): retry as interrupt.
        return this.appendOrCreateMessage(messageId, dueAt, interruptDueAt);
      }
      const row = this.get(open.id)!;
      this.addMessageToBatch(row.id, messageId);
      return { batch: row, action: row.status === 'queued' ? 'interrupt' : 'appended', revision: row.revision };
    }

    if (open.status === 'generating' && open.visible_at === null) {
      const batch = this.db.prepare(
        `UPDATE reply_batches
         SET revision = revision + 1,
             trigger_message_id = ?,
             last_message_at = ?,
             due_at = ?,
             status = 'collecting',
             interrupted_count = interrupted_count + 1,
             retry_count = 0,
             failure_code = NULL,
             last_error = NULL,
             lease_owner = NULL,
             lease_expires_at = NULL
         WHERE id = ? AND status = 'generating' AND visible_at IS NULL`
      ).run(messageId, ts, interruptDueAt, open.id);
      if (batch.changes !== 1) return this.appendOrCreateMessage(messageId, dueAt, interruptDueAt);
      const row = this.get(open.id)!;
      this.addMessageToBatch(row.id, messageId);
      return { batch: row, action: 'interrupt', revision: row.revision };
    }

    // publishing / completed / failed / superseded / cancelled: new batch.
    const id = sortableId('rb');
    this.db.prepare(
      `INSERT INTO reply_batches(
         id, conversation_id, status, trigger_message_id, opened_at, due_at,
         revision, last_message_at)
       VALUES (?, 'main', 'collecting', ?, ?, ?, 1, ?)`
    ).run(id, messageId, ts, dueAt, ts);
    const batch = this.get(id)!;
    this.addMessageToBatch(batch.id, messageId);
    return { batch, action: 'next_batch', revision: 1 };
  }

  /** The newest non-terminal batch, if any. */
  openBatch(): ReplyBatchRow | undefined {
    return this.db.prepare(
      `SELECT * FROM reply_batches
       WHERE conversation_id = 'main' AND status IN ('collecting','queued','generating','publishing')
       ORDER BY opened_at DESC LIMIT 1`
    ).get() as ReplyBatchRow | undefined;
  }

  get(id: string): ReplyBatchRow | undefined {
    return this.db.prepare('SELECT * FROM reply_batches WHERE id = ?').get(id) as ReplyBatchRow | undefined;
  }

  findByMessage(messageId: string): ReplyBatchRow | undefined {
    return this.db.prepare(
      `SELECT b.* FROM reply_batches b JOIN reply_batch_messages bm ON bm.batch_id = b.id WHERE bm.message_id = ?`
    ).get(messageId) as ReplyBatchRow | undefined;
  }

  messageIds(batchId: string): string[] {
    return (this.db.prepare(
      'SELECT message_id FROM reply_batch_messages WHERE batch_id = ? ORDER BY position'
    ).all(batchId) as Array<{ message_id: string }>).map((row) => row.message_id);
  }

  isCurrentRevision(batchId: string, revision: number): boolean {
    const row = this.db.prepare('SELECT revision, status FROM reply_batches WHERE id = ?').get(batchId) as
      | { revision: number; status: string }
      | undefined;
    return row !== undefined && row.revision === revision && row.status !== 'superseded' && row.status !== 'cancelled';
  }

  /** Claims the batch for generation. Revision is fenced: a stale claim is refused. */
  beginGenerating(batchId: string, revision: number, owner: string, leaseMs: number): ReplyBatchRow | undefined {
    const ts = nowIso();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.db.prepare(
      `UPDATE reply_batches
       SET status = 'generating', started_at = ?, attempts = attempts + 1,
           last_error = NULL, lease_owner = ?, lease_expires_at = ?,
           generation_started_at = ?
       WHERE id = ? AND status = 'queued' AND revision = ?`
    ).run(ts, owner, expiresAt, ts, batchId, revision).changes;
    return changed === 1 ? this.get(batchId) : undefined;
  }

  /**
   * Opens the publish barrier. The only way a generation may start showing
   * text. Loses (returns false) when the revision moved on or another worker
   * already opened the barrier.
   */
  beginPublishing(batchId: string, revision: number, owner: string): boolean {
    const ts = nowIso();
    return this.db.prepare(
      `UPDATE reply_batches
       SET status = 'publishing', publish_started_at = ?, visible_at = ?,
           lease_owner = ?, lease_expires_at = ?
       WHERE id = ? AND revision = ? AND status = 'generating' AND visible_at IS NULL`
    ).run(ts, ts, owner, new Date(Date.now() + 120_000).toISOString(), batchId, revision).changes === 1;
  }

  renewLease(id: string, owner: string, leaseMs: number): boolean {
    return this.db.prepare(
      "UPDATE reply_batches SET lease_expires_at = ? WHERE id = ? AND status IN ('generating','publishing') AND lease_owner = ?"
    ).run(new Date(Date.now() + leaseMs).toISOString(), id, owner).changes === 1;
  }

  /** Marks the batch completed with its assistant message. Fenced on revision. */
  complete(batchId: string, revision: number, assistantMessageId: string, owner: string, partial = false): boolean {
    const ts = nowIso();
    return this.db.prepare(
      `UPDATE reply_batches
       SET status = 'completed', assistant_message_id = ?, completed_at = ?,
           last_error = NULL, lease_owner = NULL, lease_expires_at = NULL,
           meta_json = CASE WHEN ? = 1 THEN json_set(meta_json, '$.partial', 1) ELSE meta_json END
       WHERE id = ? AND revision = ? AND status = 'publishing' AND lease_owner = ?`
    ).run(assistantMessageId, ts, partial ? 1 : 0, batchId, revision, owner).changes === 1;
  }

  /** Fails the batch with a structured code. Fenced on revision + owner. */
  fail(batchId: string, revision: number, code: string, error: string, owner?: string): void {
    this.db.prepare(
      `UPDATE reply_batches
       SET status = 'failed', last_error = ?, completed_at = ?, failure_code = ?,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND revision = ? AND (? IS NULL OR lease_owner = ?)`
    ).run(error.slice(0, 2000), nowIso(), code.slice(0, 120), batchId, revision, owner ?? null, owner ?? null);
  }

  /** The generation was superseded by newer user input: terminal, not an error. */
  markSuperseded(batchId: string, revision: number, reason: string): boolean {
    return this.db.prepare(
      `UPDATE reply_batches
       SET status = 'superseded', superseded_at = ?, last_error = ?,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND revision = ? AND status IN ('generating','queued','collecting') AND visible_at IS NULL`
    ).run(nowIso(), reason.slice(0, 500), batchId, revision).changes === 1;
  }

  /** Explicit user retry: bump revision, clear counters, back to queued. */
  retry(batchId: string): ReplyBatchRow | undefined {
    const changed = this.db.prepare(
      `UPDATE reply_batches
       SET status = 'queued', revision = revision + 1, retry_count = 0,
           failure_code = NULL, last_error = NULL, lease_owner = NULL,
           lease_expires_at = NULL, completed_at = NULL
       WHERE id = ? AND (status = 'failed' OR (status = 'completed' AND json_extract(meta_json, '$.partial') = 1))`
    ).run(batchId).changes;
    return changed === 1 ? this.get(batchId) : undefined;
  }

  /** Counts one automatic retry (bounded by coordinator policy). */
  incrementRetry(id: string, revision: number): boolean {
    return this.db.prepare(
      "UPDATE reply_batches SET retry_count = retry_count + 1 WHERE id = ? AND revision = ? AND status = 'generating'"
    ).run(id, revision).changes === 1;
  }

  requeue(id: string, revision: number, error: string, owner: string): boolean {
    return this.db.prepare(
      `UPDATE reply_batches
       SET status = 'queued', last_error = ?, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND revision = ? AND status = 'generating' AND lease_owner = ?`
    ).run(error.slice(0, 2000), id, revision, owner).changes === 1;
  }

  recoverOpen(): ReplyBatchRow[] {
    return this.db.transaction(() => {
      // In-flight generations lost their model connection on restart: same
      // revision, regenerated from scratch (nothing was visible yet).
      this.db.prepare(
        `UPDATE reply_batches
         SET status = 'queued', last_error = 'interrupted by restart',
             lease_owner = NULL, lease_expires_at = NULL
         WHERE status IN ('generating','publishing')
           AND visible_at IS NULL
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
      ).run(nowIso());
      // A publishing batch with visible text keeps its published content but
      // cannot be resumed mid-stream: the assistant message stays, and the
      // batch is marked completed/partial so we never regenerate over it.
      this.db.prepare(
        `UPDATE reply_batches
         SET status = 'completed', completed_at = ?,
             last_error = 'interrupted by restart (published content kept)',
             meta_json = json_set(meta_json, '$.partial', 1),
             lease_owner = NULL, lease_expires_at = NULL
         WHERE status = 'publishing' AND visible_at IS NOT NULL`
      ).run(nowIso());
      // Legacy 'running' rows from before migration 15 behave like generating.
      this.db.prepare(
        `UPDATE reply_batches SET status = 'generating'
         WHERE status = 'running' AND visible_at IS NULL`
      ).run();
      this.db.prepare("UPDATE reply_batches SET status = 'queued' WHERE status = 'collecting' AND due_at <= ?").run(nowIso());
      return this.db.prepare(
        "SELECT * FROM reply_batches WHERE status IN ('collecting','queued','generating') ORDER BY opened_at"
      ).all() as ReplyBatchRow[];
    })();
  }

  recoverExpired(id: string): boolean {
    return this.db.prepare(
      `UPDATE reply_batches
       SET status = 'queued', last_error = 'lease expired',
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND status IN ('generating','publishing')
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
    ).run(id, nowIso()).changes === 1;
  }

  /** Marks a hidden-generation batch as superseded when the whole batch was replaced. */
  supersedeIfOpen(id: string, reason: string): boolean {
    return this.db.prepare(
      `UPDATE reply_batches
       SET status = 'superseded', superseded_at = ?, last_error = ?,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND status IN ('collecting','queued','generating') AND visible_at IS NULL`
    ).run(nowIso(), reason.slice(0, 500), id).changes === 1;
  }

  // ---- generation audit ----

  recordGeneration(input: GenerationAuditInput): void {
    this.db.prepare(
      `INSERT INTO reply_generations(
         id, batch_id, revision, attempt, status, started_at, finished_at,
         interruption_reason, error_code, duration_ms, first_token_ms, visible_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sortableId('rgen'),
      input.batchId,
      input.revision,
      input.attempt,
      input.status,
      input.startedAt,
      input.finishedAt ?? null,
      input.interruptionReason ?? null,
      input.errorCode ?? null,
      input.durationMs ?? null,
      input.firstTokenMs ?? null,
      input.visibleMs ?? null
    );
  }

  private addMessageToBatch(batchId: string, messageId: string): void {
    const position = (this.db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM reply_batch_messages WHERE batch_id = ?'
    ).get(batchId) as { position: number }).position;
    this.db.prepare(
      'INSERT INTO reply_batch_messages(batch_id, message_id, position, created_at) VALUES (?, ?, ?, ?)'
    ).run(batchId, messageId, position, nowIso());
  }
}
