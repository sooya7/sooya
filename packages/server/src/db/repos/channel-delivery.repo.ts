import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

/*
 * 通道投递 outbox（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §9）。
 * 所有发往 QQ 的 assistant 消息先落库再发送：(channel, message_id,
 * external_conversation_id) 唯一约束保证「一条 SOOYA 消息只对应一次成功投递」——
 * Worker 重启、Job 重试、Server 重启都不会重复发送。
 */
export type ChannelDeliveryStatus = 'pending' | 'sending' | 'retry' | 'sent' | 'failed';

export interface ChannelDeliveryRow {
  id: string;
  channel: string;
  message_id: string;
  external_conversation_id: string;
  status: ChannelDeliveryStatus;
  attempts: number;
  next_retry_at: string | null;
  remote_message_id: string | null;
  last_error_code: string | null;
  last_error_summary: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export interface ChannelDeliveryInsert {
  channel: string;
  messageId: string;
  externalConversationId: string;
}

/** 重试退避（§9.1）：第 1 次立即、2 次 5s、3 次 30s、4 次 2min、5 次 10min…… */
export function deliveryRetryDelayMs(attempt: number): number {
  const steps = [0, 5_000, 30_000, 120_000, 600_000];
  return steps[Math.min(attempt, steps.length) - 1] ?? 600_000;
}

export class ChannelDeliveryRepo {
  constructor(private readonly db: DbLike) {}

  /** 幂等入队：已存在（含已发送）返回现有行。 */
  enqueue(input: ChannelDeliveryInsert): { inserted: boolean; row: ChannelDeliveryRow } {
    const id = sortableId('chdel');
    const now = nowIso();
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO channel_delivery(
          id, channel, message_id, external_conversation_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `)
      .run(id, input.channel, input.messageId, input.externalConversationId, now, now);
    const row = this.find(input.channel, input.messageId, input.externalConversationId);
    return { inserted: result.changes === 1, row: row! };
  }

  find(channel: string, messageId: string, externalConversationId: string): ChannelDeliveryRow | undefined {
    return this.db
      .prepare('SELECT * FROM channel_delivery WHERE channel = ? AND message_id = ? AND external_conversation_id = ?')
      .get(channel, messageId, externalConversationId) as ChannelDeliveryRow | undefined;
  }

  getById(id: string): ChannelDeliveryRow | undefined {
    return this.db.prepare('SELECT * FROM channel_delivery WHERE id = ?').get(id) as ChannelDeliveryRow | undefined;
  }

  /**
   * 条件领取：只有 pending/retry 行可以变为 sending。并发 Worker / 重启兜底场景下
   * 只有一个执行者能赢，杜绝同一消息并发发送。
   */
  claim(id: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE channel_delivery
        SET status = 'sending', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'retry')
      `)
      .run(nowIso(), id);
    return result.changes === 1;
  }

  markSent(id: string, remoteMessageId: string): void {
    this.db
      .prepare(`
        UPDATE channel_delivery
        SET status = 'sent', remote_message_id = ?, delivered_at = ?, last_error_code = NULL,
            last_error_summary = NULL, next_retry_at = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(remoteMessageId, nowIso(), nowIso(), id);
  }

  markRetry(id: string, errorCode: string, errorSummary: string, attempts: number): void {
    this.db
      .prepare(`
        UPDATE channel_delivery
        SET status = 'retry', next_retry_at = ?, last_error_code = ?, last_error_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(new Date(Date.now() + deliveryRetryDelayMs(attempts)).toISOString(), errorCode, errorSummary.slice(0, 500), nowIso(), id);
  }

  markFailed(id: string, errorCode: string, errorSummary: string): void {
    this.db
      .prepare(`
        UPDATE channel_delivery
        SET status = 'failed', last_error_code = ?, last_error_summary = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(errorCode, errorSummary.slice(0, 500), nowIso(), id);
  }

  /** Admin 手动重试：failed/retry 行重置为 pending，清空退避。 */
  resetForRetry(id: string): boolean {
    const result = this.db
      .prepare(`
        UPDATE channel_delivery
        SET status = 'pending', next_retry_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('failed', 'retry')
      `)
      .run(nowIso(), id);
    return result.changes === 1;
  }

  /** 是否有待投递/在途投递（冲突控制：QQ 还有未完成消息时不插队）。 */
  hasInFlight(channel: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS hit FROM channel_delivery WHERE channel = ? AND status IN ('pending','sending','retry') LIMIT 1")
      .get(channel) as { hit: number } | undefined;
    return row !== undefined;
  }

  /** 启动恢复：把中断在 sending 的投递放回 pending，由后续扫描/任务重新领取。 */
  recoverInFlight(): void {
    this.db
      .prepare("UPDATE channel_delivery SET status = 'pending', updated_at = ? WHERE status = 'sending'")
      .run(nowIso());
  }

  /** 到期待投递（pending/retry 且 next_retry_at 已到或为空，含重启恢复）。 */
  dueNow(channel: string, limit = 50): ChannelDeliveryRow[] {
    return this.db
      .prepare(`
        SELECT * FROM channel_delivery
        WHERE channel = ? AND status IN ('pending', 'retry')
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY created_at ASC LIMIT ?
      `)
      .all(channel, nowIso(), limit) as ChannelDeliveryRow[];
  }

  byMessageId(messageId: string): ChannelDeliveryRow | undefined {
    return this.db
      .prepare('SELECT * FROM channel_delivery WHERE message_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(messageId) as ChannelDeliveryRow | undefined;
  }

  countByStatus(channel: string, ...statuses: ChannelDeliveryStatus[]): number {
    if (statuses.length === 0) return 0;
    const marks = statuses.map(() => '?').join(',');
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM channel_delivery WHERE channel = ? AND status IN (${marks})`)
      .get(channel, ...statuses) as { n: number };
    return row.n;
  }

  recent(channel: string, limit = 30): ChannelDeliveryRow[] {
    return this.db
      .prepare('SELECT * FROM channel_delivery WHERE channel = ? ORDER BY created_at DESC LIMIT ?')
      .all(channel, limit) as ChannelDeliveryRow[];
  }
}