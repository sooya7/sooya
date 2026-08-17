import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

/*
 * 通道身份映射（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §7）。
 * 当前只有 QQ，仍保留独立表以稳定解决「QQ 用户 / 群 → SOOYA 内部会话」，
 * 而不是为单通道造出多通道框架。单用户环境规则：
 * - 首个授权用户绑定为 owner
 * - 其他用户拒绝或忽略（QQ_ALLOWED_USERS 之外未经授权也不绑定）
 * - 不允许通过普通 QQ 消息修改 owner
 */
export type ChannelIdentityRole = 'owner' | 'user';

export interface ChannelIdentityRow {
  id: string;
  channel: string;
  external_user_id: string;
  external_conversation_id: string;
  scene: string;
  sooya_conversation_id: string;
  role: ChannelIdentityRole;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}

export interface ChannelIdentityInput {
  channel: string;
  externalUserId: string;
  externalConversationId: string;
  scene?: string;
  sooyaConversationId?: string;
  role?: ChannelIdentityRole;
}

export class ChannelIdentityRepo {
  constructor(private readonly db: DbLike) {}

  findByUser(channel: string, externalUserId: string): ChannelIdentityRow | undefined {
    return this.db
      .prepare('SELECT * FROM channel_identity WHERE channel = ? AND external_user_id = ?')
      .get(channel, externalUserId) as ChannelIdentityRow | undefined;
  }

  findOwner(channel: string): ChannelIdentityRow | undefined {
    return this.db
      .prepare("SELECT * FROM channel_identity WHERE channel = ? AND role = 'owner' ORDER BY created_at ASC LIMIT 1")
      .get(channel) as ChannelIdentityRow | undefined;
  }

  bindOwner(input: ChannelIdentityInput): ChannelIdentityRow {
    const now = nowIso();
    const existing = this.findByUser(input.channel, input.externalUserId);
    if (existing) {
      this.touch(input.channel, input.externalUserId);
      return existing;
    }
    const id = sortableId('chid');
    const row: ChannelIdentityRow = {
      id,
      channel: input.channel,
      external_user_id: input.externalUserId,
      external_conversation_id: input.externalConversationId,
      scene: input.scene ?? 'c2c',
      sooya_conversation_id: input.sooyaConversationId ?? 'main',
      role: input.role ?? 'owner',
      enabled: 1,
      created_at: now,
      updated_at: now,
      last_seen_at: now
    };
    this.db
      .prepare(`
        INSERT INTO channel_identity(
          id, channel, external_user_id, external_conversation_id, scene,
          sooya_conversation_id, role, enabled, created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        row.id,
        row.channel,
        row.external_user_id,
        row.external_conversation_id,
        row.scene,
        row.sooya_conversation_id,
        row.role,
        row.enabled,
        row.created_at,
        row.updated_at,
        row.last_seen_at
      );
    return row;
  }

  touch(channel: string, externalUserId: string): void {
    this.db
      .prepare(`
        UPDATE channel_identity
        SET last_seen_at = ?, updated_at = ?
        WHERE channel = ? AND external_user_id = ?
      `)
      .run(nowIso(), nowIso(), channel, externalUserId);
  }

  setEnabled(channel: string, externalUserId: string, enabled: boolean): void {
    this.db
      .prepare(`
        UPDATE channel_identity
        SET enabled = ?, updated_at = ?
        WHERE channel = ? AND external_user_id = ?
      `)
      .run(enabled ? 1 : 0, nowIso(), channel, externalUserId);
  }

  /** Admin/审计用：该通道全部绑定关系（不含 Secret）。 */
  list(channel: string): ChannelIdentityRow[] {
    return this.db
      .prepare('SELECT * FROM channel_identity WHERE channel = ? ORDER BY created_at ASC')
      .all(channel) as ChannelIdentityRow[];
  }
}