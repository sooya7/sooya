import type { ChannelIdentityRepo, ChannelIdentityRole } from '../../db/repos/channel-identity.repo.js';
import type { QqBotConfig } from './config.js';
import { QQ_CHANNEL_NAME, QQ_SCENE_C2C } from './types.js';

/*
 * QQ 用户 / 群 → SOOYA 会话映射（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §7）。
 * 单用户环境规则：首个授权用户绑定为 owner；其他用户拒绝或忽略；
 * 不允许通过普通 QQ 消息修改 owner。
 */
export type QqIdentityDecision =
  | { role: 'owner' | 'user'; sooyaConversationId: string; newlyBound: boolean }
  | { role: 'denied'; reason: 'not_allowed' | 'already_owned' | 'disabled' };

export interface QqMappingDeps {
  config: QqBotConfig;
  identities: ChannelIdentityRepo;
}

export function resolveQqIdentity(
  deps: QqMappingDeps,
  input: { externalUserId: string; externalConversationId: string; scene?: string }
): QqIdentityDecision {
  const { identities, config } = deps;
  const channel = QQ_CHANNEL_NAME;
  const existing = identities.findByUser(channel, input.externalUserId);
  if (existing) {
    identities.touch(channel, input.externalUserId);
    if (!existing.enabled) return { role: 'denied', reason: 'disabled' };
    return { role: existing.role, sooyaConversationId: existing.sooya_conversation_id, newlyBound: false };
  }
  // 白名单之外的用户：不绑定、不处理。
  if (!config.allowedUsers.includes(input.externalUserId)) return { role: 'denied', reason: 'not_allowed' };
  // 单用户限制：owner 已存在且不是本人 → 拒绝，绝不让第二个用户接管。
  const owner = identities.findOwner(channel);
  if (owner && owner.external_user_id !== input.externalUserId) return { role: 'denied', reason: 'already_owned' };
  const row = identities.bindOwner({
    channel,
    externalUserId: input.externalUserId,
    externalConversationId: input.externalConversationId,
    scene: input.scene ?? QQ_SCENE_C2C
  });
  return { role: row.role, sooyaConversationId: row.sooya_conversation_id, newlyBound: true };
}

export function identityRoleLabel(role: ChannelIdentityRole | 'denied'): string {
  return role === 'denied' ? 'denied' : role;
}