import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export type ReplyBatchStatus = 'collecting' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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
}

export class ReplyBatchRepo {
  constructor(private readonly db: DbLike) {}

  addMessage(messageId: string, dueAt: string): ReplyBatchRow {
    const existingMembership = this.db.prepare(
      `SELECT b.* FROM reply_batches b
       JOIN reply_batch_messages bm ON bm.batch_id = b.id
       WHERE bm.message_id = ?`
    ).get(messageId) as ReplyBatchRow | undefined;
    if (existingMembership) return existingMembership;

    let batch = this.db.prepare(
      "SELECT * FROM reply_batches WHERE conversation_id = 'main' AND status = 'collecting' ORDER BY opened_at DESC LIMIT 1"
    ).get() as ReplyBatchRow | undefined;
    const ts = nowIso();
    if (!batch) {
      const id = sortableId('rb');
      this.db.prepare(
        `INSERT INTO reply_batches(id, conversation_id, status, trigger_message_id, opened_at, due_at)
         VALUES (?, 'main', 'collecting', ?, ?, ?)`
      ).run(id, messageId, ts, dueAt);
      batch = this.get(id)!;
    }
    const position = (this.db.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM reply_batch_messages WHERE batch_id = ?'
    ).get(batch.id) as { position: number }).position;
    this.db.prepare(
      'INSERT INTO reply_batch_messages(batch_id, message_id, position, created_at) VALUES (?, ?, ?, ?)'
    ).run(batch.id, messageId, position, ts);
    this.db.prepare(
      'UPDATE reply_batches SET trigger_message_id = ?, due_at = ? WHERE id = ? AND status = \'collecting\''
    ).run(messageId, dueAt, batch.id);
    return this.get(batch.id)!;
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

  markQueued(id: string): boolean {
    return this.db.prepare(
      "UPDATE reply_batches SET status = 'queued' WHERE id = ? AND status = 'collecting'"
    ).run(id).changes === 1;
  }

  claim(id: string, owner: string, leaseMs: number): ReplyBatchRow | undefined {
    const ts = nowIso();
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    const changed = this.db.prepare(
      "UPDATE reply_batches SET status = 'running', started_at = ?, attempts = attempts + 1, last_error = NULL, lease_owner = ?, lease_expires_at = ? WHERE id = ? AND status = 'queued'"
    ).run(ts, owner, expiresAt, id).changes;
    return changed === 1 ? this.get(id) : undefined;
  }

  renewLease(id: string, owner: string, leaseMs: number): boolean {
    return this.db.prepare(
      "UPDATE reply_batches SET lease_expires_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ?"
    ).run(new Date(Date.now() + leaseMs).toISOString(), id, owner).changes === 1;
  }

  completeInTransaction(id: string, assistantMessageId: string, owner?: string): boolean {
    const ts = nowIso();
    return this.db.prepare(
      `UPDATE reply_batches
       SET status = 'completed', assistant_message_id = ?, completed_at = ?, last_error = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'running' AND (? IS NULL OR lease_owner = ?)`
    ).run(assistantMessageId, ts, id, owner ?? null, owner ?? null).changes === 1;
  }

  fail(id: string, error: string, owner?: string): void {
    this.db.prepare(
      "UPDATE reply_batches SET status = 'failed', last_error = ?, completed_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'running' AND (? IS NULL OR lease_owner = ?)"
    ).run(error.slice(0, 2000), nowIso(), id, owner ?? null, owner ?? null);
  }

  requeue(id: string, error: string, owner: string): boolean {
    return this.db.prepare(
      "UPDATE reply_batches SET status = 'queued', last_error = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'running' AND lease_owner = ?"
    ).run(error.slice(0, 2000), id, owner).changes === 1;
  }

  recoverOpen(): ReplyBatchRow[] {
    return this.db.transaction(() => {
      this.db.prepare(
        "UPDATE reply_batches SET status = 'queued', last_error = 'interrupted by restart', lease_owner = NULL, lease_expires_at = NULL WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)"
      ).run(nowIso());
      this.db.prepare("UPDATE reply_batches SET status = 'queued' WHERE status = 'collecting' AND due_at <= ?").run(nowIso());
      return this.db.prepare(
        "SELECT * FROM reply_batches WHERE status IN ('collecting','queued','running') ORDER BY opened_at"
      ).all() as ReplyBatchRow[];
    })();
  }

  recoverExpired(id: string): boolean {
    return this.db.prepare(
      "UPDATE reply_batches SET status = 'queued', last_error = 'lease expired', lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)"
    ).run(id, nowIso()).changes === 1;
  }
}
