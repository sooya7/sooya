import type { DbLike } from '../handle.js';
import { nextSeq } from '../index.js';
import { CONVERSATION_ID, type ChatMessage, type MessagePart, type MessageStatus, type PartStatus, type PartType, type Role } from '../../core/types.js';
import { newMessageId, nowIso, randomId } from '../../util/ids.js';
import { MediaRepo, toMediaRef } from './media.repo.js';

interface MessageRow {
  id: string;
  conversation_id: string;
  role: Role;
  created_at: string;
  updated_at: string;
  seq: number;
  status: MessageStatus;
  client_msg_id: string | null;
  reply_to: string | null;
  error: string | null;
  meta_json: string;
}

interface PartRow {
  id: string;
  message_id: string;
  idx: number;
  type: PartType;
  text: string | null;
  media_id: string | null;
  status: PartStatus;
  error: string | null;
  duration: number | null;
  transcript: string | null;
  meta_json: string;
}

export interface CreatePartInput {
  type: PartType;
  text?: string | null;
  mediaId?: string | null;
  status?: PartStatus;
  error?: string | null;
  duration?: number | null;
  transcript?: string | null;
  meta?: Record<string, unknown>;
}

export interface CreateMessageInput {
  id?: string;
  role: Role;
  status?: MessageStatus;
  clientMsgId?: string | null;
  replyTo?: string | null;
  parts: CreatePartInput[];
  meta?: Record<string, unknown>;
}

export type WithdrawResult =
  | { kind: 'withdrawn'; message: ChatMessage }
  | { kind: 'not_found' }
  | { kind: 'not_withdrawable' }
  | { kind: 'expired' }
  | { kind: 'already_withdrawn'; message: ChatMessage };

export class MessageRepo {
  private readonly media: MediaRepo;

  constructor(private readonly db: DbLike) {
    this.media = new MediaRepo(db);
  }

  /**
   * Idempotent create: if clientMsgId already exists the stored message is
   * returned untouched (and `created` is false).
   */
  create(input: CreateMessageInput): { message: ChatMessage; created: boolean } {
    return this.inTransaction(() => this.createInTransaction(input));
  }

  inTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  /**
   * Create within a transaction already coordinated by the caller.
   * This deliberately does not start another transaction.
   */
  createInTransaction(input: CreateMessageInput): { message: ChatMessage; created: boolean } {
    if (input.clientMsgId) {
      const existing = this.getByClientId(input.clientMsgId);
      if (existing) return { message: existing, created: false };
    }
    const id = input.id ?? newMessageId();
    const ts = nowIso();
    try {
      const seq = nextSeq(this.db, 'message_seq');
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, created_at, updated_at, seq, status, client_msg_id, reply_to, error, meta_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
        )
        .run(
          id,
          CONVERSATION_ID,
          input.role,
          ts,
          ts,
          seq,
          input.status ?? 'sent',
          input.clientMsgId ?? null,
          input.replyTo ?? null,
          JSON.stringify(input.meta ?? {})
        );
      input.parts.forEach((p, idx) => this.insertPart(id, idx, p));
    } catch (err) {
      // Unique index race on client_msg_id -> return the winner.
      if (input.clientMsgId) {
        const existing = this.getByClientId(input.clientMsgId);
        if (existing) return { message: existing, created: false };
      }
      throw err;
    }
    return { message: this.get(id)!, created: true };
  }

  /**
   * Conditional withdrawal state transition for a user message.
   *
   * Reads eligibility, then atomically claims the withdrawal with a
   * conditional UPDATE whose WHERE clause re-checks `withdrawnAt` absence and
   * the time window against the live row — so only one concurrent caller can
   * complete the transition. A losing caller gets zero affected rows and
   * re-reads the authoritative final state as `already_withdrawn`.
   *
   * Performs message-row and parts writes only. It deliberately opens no
   * transaction of its own (to avoid nesting) and must run inside a
   * caller-managed transaction when atomicity with audit/event writes is
   * required. It does not depend on the EventBus.
   */
  withdraw(id: string, now: number, windowMs: number): WithdrawResult {
    const message = this.get(id);
    if (!message) return { kind: 'not_found' };
    if (message.role !== 'user') return { kind: 'not_withdrawable' };
    if (message.meta?.withdrawnAt) return { kind: 'already_withdrawn', message };
    if (now - Date.parse(message.createdAt) > windowMs) return { kind: 'expired' };

    const withdrawnAt = new Date(now).toISOString();
    const cutoff = new Date(now - windowMs).toISOString();
    const nextMeta = {
      ...(message.meta ?? {}),
      withdrawnAt,
      originalPartTypes: message.content.map((part) => part.type)
    };

    // Atomic guard: only succeeds while the row is still a non-withdrawn user
    // message within the window. A concurrent winner sets withdrawnAt first,
    // so this UPDATE affects zero rows and we re-read below.
    const guard = this.db
      .prepare(
        `UPDATE messages SET meta_json = ?, updated_at = ?
         WHERE id = ? AND role = 'user'
           AND json_extract(meta_json, '$.withdrawnAt') IS NULL
           AND created_at >= ?`
      )
      .run(JSON.stringify(nextMeta), withdrawnAt, id, cutoff);

    if (guard.changes === 1) {
      this.db.prepare('DELETE FROM message_parts WHERE message_id = ?').run(id);
      this.db
        .prepare(
          `INSERT INTO message_parts(id, message_id, idx, type, text, media_id, status, error, duration, transcript, meta_json)
           VALUES (?, ?, 0, 'text', ?, NULL, 'sent', NULL, NULL, NULL, '{}')`
        )
        .run(`part_${randomId(14)}`, id, '[消息已撤回]');
      return { kind: 'withdrawn', message: this.get(id)! };
    }

    // Lost the race (or the row changed between read and write): re-read and
    // report the true final state.
    const current = this.get(id);
    if (!current) return { kind: 'not_found' };
    if (current.meta?.withdrawnAt) return { kind: 'already_withdrawn', message: current };
    if (now - Date.parse(current.createdAt) > windowMs) return { kind: 'expired' };
    return { kind: 'not_withdrawable' };
  }

  private insertPart(messageId: string, idx: number, p: CreatePartInput): string {
    const partId = `part_${randomId(14)}`;
    this.db
      .prepare(
        `INSERT INTO message_parts (id, message_id, idx, type, text, media_id, status, error, duration, transcript, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        partId,
        messageId,
        idx,
        p.type,
        p.text ?? null,
        p.mediaId ?? null,
        p.status ?? 'sent',
        p.error ?? null,
        p.duration ?? null,
        p.transcript ?? null,
        JSON.stringify(p.meta ?? {})
      );
    return partId;
  }

  appendPart(messageId: string, part: CreatePartInput): string {
    const row = this.db.prepare('SELECT COALESCE(MAX(idx), -1) m FROM message_parts WHERE message_id = ?').get(messageId) as {
      m: number;
    };
    const id = this.insertPart(messageId, row.m + 1, part);
    this.touch(messageId);
    return id;
  }

  updatePart(partId: string, patch: Partial<CreatePartInput>): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.text !== undefined) (sets.push('text = ?'), values.push(patch.text));
    if (patch.mediaId !== undefined) (sets.push('media_id = ?'), values.push(patch.mediaId));
    if (patch.status !== undefined) (sets.push('status = ?'), values.push(patch.status));
    if (patch.error !== undefined) (sets.push('error = ?'), values.push(patch.error));
    if (patch.duration !== undefined) (sets.push('duration = ?'), values.push(patch.duration));
    if (patch.transcript !== undefined) (sets.push('transcript = ?'), values.push(patch.transcript));
    if (patch.meta !== undefined) (sets.push('meta_json = ?'), values.push(JSON.stringify(patch.meta)));
    if (sets.length === 0) return;
    values.push(partId);
    this.db.prepare(`UPDATE message_parts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deletePart(partId: string): void {
    this.db.prepare('DELETE FROM message_parts WHERE id = ?').run(partId);
  }

  setStatus(messageId: string, status: MessageStatus, error?: string | null): void {
    this.db
      .prepare('UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, error ?? null, nowIso(), messageId);
  }

  updateMeta(messageId: string, patch: Record<string, unknown>): void {
    const row = this.db.prepare('SELECT meta_json FROM messages WHERE id = ?').get(messageId) as { meta_json: string } | undefined;
    if (!row) return;
    let current: Record<string, unknown> = {};
    try { current = JSON.parse(row.meta_json) as Record<string, unknown>; } catch { /* replace invalid historical metadata */ }
    this.db.prepare('UPDATE messages SET meta_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...current, ...patch }), nowIso(), messageId);
  }

  touch(messageId: string): void {
    this.db.prepare('UPDATE messages SET updated_at = ? WHERE id = ?').run(nowIso(), messageId);
  }

  get(id: string): ChatMessage | undefined {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    if (!row) return undefined;
    return this.hydrate([row])[0];
  }

  getByClientId(clientMsgId: string): ChatMessage | undefined {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND client_msg_id = ?')
      .get(CONVERSATION_ID, clientMsgId) as MessageRow | undefined;
    if (!row) return undefined;
    return this.hydrate([row])[0];
  }

  findAssistantByBatchId(batchId: string): ChatMessage | undefined {
    const row = this.db.prepare(
      `SELECT * FROM messages
       WHERE conversation_id = ? AND role = 'assistant' AND json_extract(meta_json, '$.batchId') = ?
       ORDER BY seq DESC LIMIT 1`
    ).get(CONVERSATION_ID, batchId) as MessageRow | undefined;
    return row ? this.hydrate([row])[0] : undefined;
  }

  failInterruptedBatchShell(batchId: string): number {
    return this.db.prepare(
      `UPDATE messages SET status = 'failed', error = 'interrupted by restart', updated_at = ?
       WHERE role = 'assistant' AND status = 'sending' AND json_extract(meta_json, '$.batchId') = ?`
    ).run(nowIso(), batchId).changes;
  }

  /** Newest-first page. `beforeSeq` is exclusive. */
  page(limit: number, beforeSeq?: number | null): { messages: ChatMessage[]; hasMore: boolean } {
    const capped = Math.max(1, Math.min(limit, 200));
    const rows = (
      beforeSeq && beforeSeq > 0
        ? this.db
            .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
            .all(CONVERSATION_ID, beforeSeq, capped + 1)
        : this.db
            .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?')
            .all(CONVERSATION_ID, capped + 1)
    ) as MessageRow[];
    const hasMore = rows.length > capped;
    const page = rows.slice(0, capped).reverse();
    return { messages: this.hydrate(page), hasMore };
  }

  /** Messages strictly after a given seq (used for reconnect catch-up). */
  since(seq: number, limit = 200): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(CONVERSATION_ID, seq, limit) as MessageRow[];
    return this.hydrate(rows);
  }

  /**
   * Oldest-first page of messages strictly after `seq`, for bounded reconnect
   * catch-up. Reads one extra row to decide `hasMore` without a second query.
   * `nextSince` is the cursor the client should send to fetch the next page.
   */
  pageSince(seq: number, limit = 200): { messages: ChatMessage[]; hasMore: boolean; nextSince: number } {
    const capped = Math.max(1, Math.min(limit, 200));
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(CONVERSATION_ID, seq, capped + 1) as MessageRow[];
    const hasMore = rows.length > capped;
    const page = rows.slice(0, capped);
    const nextSince = page[page.length - 1]?.seq ?? seq;
    return { messages: this.hydrate(page), hasMore, nextSince };
  }

  range(fromSeq: number, toSeq: number): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC')
      .all(CONVERSATION_ID, fromSeq, toSeq) as MessageRow[];
    return this.hydrate(rows);
  }

  recent(limit: number): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?')
      .all(CONVERSATION_ID, limit) as MessageRow[];
    return this.hydrate(rows.reverse());
  }

  maxSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM messages WHERE conversation_id = ?').get(CONVERSATION_ID) as {
      s: number;
    };
    return row.s;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
  }

  clearAll(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM message_parts').run();
      this.db.prepare('DELETE FROM messages').run();
      this.db.prepare('DELETE FROM summaries').run();
    });
    tx();
  }

  hydrate(rows: MessageRow[]): ChatMessage[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const parts = this.db
      .prepare(`SELECT * FROM message_parts WHERE message_id IN (${placeholders}) ORDER BY message_id, idx`)
      .all(...ids) as PartRow[];
    const mediaIds = [...new Set(parts.map((p) => p.media_id).filter((x): x is string => !!x))];
    const mediaMap = this.media.getMany(mediaIds);
    const byMessage = new Map<string, MessagePart[]>();
    for (const p of parts) {
      const list = byMessage.get(p.message_id) ?? [];
      const mediaRow = p.media_id ? mediaMap.get(p.media_id) : undefined;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(p.meta_json) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      list.push({
        id: p.id,
        type: p.type,
        text: p.text,
        mediaId: p.media_id,
        status: p.status,
        error: p.error,
        duration: p.duration ?? mediaRow?.duration ?? null,
        transcript: p.transcript ?? mediaRow?.transcript ?? null,
        meta,
        media: mediaRow ? toMediaRef(mediaRow) : null
      });
      byMessage.set(p.message_id, list);
    }
    return rows.map((r) => {
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(r.meta_json) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      return {
        id: r.id,
        conversationId: r.conversation_id,
        role: r.role,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        seq: r.seq,
        status: r.status,
        clientMsgId: r.client_msg_id,
        replyTo: r.reply_to,
        error: r.error,
        content: byMessage.get(r.id) ?? [],
        meta
      };
    });
  }
}
