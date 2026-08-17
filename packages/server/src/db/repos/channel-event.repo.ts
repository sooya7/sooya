import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

/*
 * 通道事件幂等表（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §6）。
 * 每个外部事件只允许处理一次：QQ 重推、webhook 超时重试、服务重启后重放
 * 都会被 (channel, event_id) 唯一约束挡住。
 * - event_id         = 平台事件 id（重推时相同）
 * - remote_message_id = 平台消息 id（QQ 的 d.id），引用消息（quote）按它反查
 * - message_id       = 处理完成后回填的 SOOYA 消息 id
 */
export type ChannelEventStatus = 'received' | 'processed' | 'failed' | 'rejected';

export interface ChannelEventRow {
  id: string;
  channel: string;
  event_id: string;
  remote_message_id: string | null;
  event_type: string;
  conversation_key: string | null;
  message_id: string | null;
  received_at: string;
  processed_at: string | null;
  status: ChannelEventStatus;
  error_code: string | null;
}

export interface ChannelEventInsert {
  channel: string;
  eventId: string;
  remoteMessageId?: string | null;
  eventType: string;
  conversationKey?: string | null;
  /** 平台消息 ID（QQ 的 d.id）；处理完成后回填 SOOYA message id 供 quote 解析。 */
  messageId?: string | null;
  status?: ChannelEventStatus;
}

export interface MarkResult {
  inserted: boolean;
  row: ChannelEventRow;
}

export class ChannelEventRepo {
  constructor(private readonly db: DbLike) {}

  /**
   * 幂等写入。已存在（重推/重放）返回 inserted:false，调用方必须直接 ACK。
   */
  markReceived(input: ChannelEventInsert): MarkResult {
    const id = sortableId('chevt');
    const receivedAt = nowIso();
    const status = input.status ?? 'received';
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO channel_event(
          id, channel, event_id, remote_message_id, event_type, conversation_key, message_id, received_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.channel,
        input.eventId,
        input.remoteMessageId ?? null,
        input.eventType,
        input.conversationKey ?? null,
        input.messageId ?? null,
        receivedAt,
        status
      );
    const row = this.find(input.channel, input.eventId);
    if (row) return { inserted: result.changes === 1, row };
    return {
      inserted: result.changes === 1,
      row: {
        id,
        channel: input.channel,
        event_id: input.eventId,
        remote_message_id: input.remoteMessageId ?? null,
        event_type: input.eventType,
        conversation_key: input.conversationKey ?? null,
        message_id: input.messageId ?? null,
        received_at: receivedAt,
        processed_at: null,
        status,
        error_code: null
      }
    };
  }

  find(channel: string, eventId: string): ChannelEventRow | undefined {
    return this.db
      .prepare('SELECT * FROM channel_event WHERE channel = ? AND event_id = ?')
      .get(channel, eventId) as ChannelEventRow | undefined;
  }

  /** 按平台消息 id 反查（quote 解析：从被引用的 QQ 消息找到 SOOYA 消息）。 */
  findByRemoteMessageId(remoteMessageId: string): ChannelEventRow | undefined {
    return this.db
      .prepare('SELECT * FROM channel_event WHERE remote_message_id = ? ORDER BY received_at DESC LIMIT 1')
      .get(remoteMessageId) as ChannelEventRow | undefined;
  }

  markProcessed(channel: string, eventId: string, messageId: string | null): void {
    this.db
      .prepare(`
        UPDATE channel_event
        SET status = 'processed', processed_at = ?, message_id = COALESCE(?, message_id)
        WHERE channel = ? AND event_id = ?
      `)
      .run(nowIso(), messageId, channel, eventId);
  }

  markFailed(channel: string, eventId: string, errorCode: string): void {
    this.db
      .prepare(`
        UPDATE channel_event
        SET status = 'failed', processed_at = ?, error_code = ?
        WHERE channel = ? AND event_id = ?
      `)
      .run(nowIso(), errorCode, channel, eventId);
  }

  markRejected(channel: string, eventId: string, errorCode: string): void {
    this.db
      .prepare(`
        UPDATE channel_event
        SET status = 'rejected', processed_at = ?, error_code = ?
        WHERE channel = ? AND event_id = ?
      `)
      .run(nowIso(), errorCode, channel, eventId);
  }

  recent(channel: string, limit = 30): ChannelEventRow[] {
    return this.db
      .prepare('SELECT * FROM channel_event WHERE channel = ? ORDER BY received_at DESC LIMIT ?')
      .all(channel, limit) as ChannelEventRow[];
  }

  countByStatus(channel: string, ...statuses: ChannelEventStatus[]): number {
    if (statuses.length === 0) return 0;
    const marks = statuses.map(() => '?').join(',');
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM channel_event WHERE channel = ? AND status IN (${marks})`)
      .get(channel, ...statuses) as { n: number };
    return row.n;
  }
}