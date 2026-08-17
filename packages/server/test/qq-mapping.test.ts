import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { resolveQqIdentity } from '../src/channels/qq/mapping.js';
import { QQ_CHANNEL_NAME } from '../src/channels/qq/types.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

async function identityDeps(allowedUsers: string[]) {
  h = await createHarness({ startWorkers: false });
  return {
    deps: {
      config: {
        enabled: true,
        appId: '102000000',
        appSecret: 's',
        callbackSecret: 'c',
        env: 'production' as const,
        allowedUsers,
        proactiveEnabled: true
      },
      identities: h.app.repos.channelIdentities
    }
  };
}

describe('qq identity mapping (single owner)', () => {
  it('binds the first authorized user as owner', async () => {
    const { deps } = await identityDeps(['owner-uuid']);
    const decision = resolveQqIdentity(deps, { externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
    expect(decision).toMatchObject({ role: 'owner', sooyaConversationId: 'main', newlyBound: true });
    expect(h!.app.repos.channelIdentities.findOwner(QQ_CHANNEL_NAME)?.external_user_id).toBe('owner-uuid');
  });

  it('reuses an existing bind on later messages', async () => {
    const { deps } = await identityDeps(['owner-uuid']);
    resolveQqIdentity(deps, { externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
    const again = resolveQqIdentity(deps, { externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
    expect(again).toMatchObject({ role: 'owner', newlyBound: false });
    const all = h!.app.repos.channelIdentities.list(QQ_CHANNEL_NAME);
    expect(all).toHaveLength(1);
  });

  it('denies a user outside the allowlist without creating a bind', async () => {
    const { deps } = await identityDeps(['owner-uuid']);
    const decision = resolveQqIdentity(deps, { externalUserId: 'stranger', externalConversationId: 'stranger' });
    expect(decision).toEqual({ role: 'denied', reason: 'not_allowed' });
    expect(h!.app.repos.channelIdentities.list(QQ_CHANNEL_NAME)).toHaveLength(0);
  });

  it('refuses a second user when an owner already exists', async () => {
    const { deps } = await identityDeps(['owner-uuid', 'second-uuid']);
    resolveQqIdentity(deps, { externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
    const second = resolveQqIdentity(deps, { externalUserId: 'second-uuid', externalConversationId: 'second-uuid' });
    expect(second).toEqual({ role: 'denied', reason: 'already_owned' });
    expect(h!.app.repos.channelIdentities.findOwner(QQ_CHANNEL_NAME)?.external_user_id).toBe('owner-uuid');
  });

  it('denies a disabled identity even if previously owner', async () => {
    const { deps } = await identityDeps(['owner-uuid']);
    resolveQqIdentity(deps, { externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
    h!.app.repos.channelIdentities.setEnabled(QQ_CHANNEL_NAME, 'owner-uuid', false);
    const decision = resolveQqIdentity(deps, { externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
    expect(decision).toEqual({ role: 'denied', reason: 'disabled' });
  });

  it('keeps the owner binding stable over many messages', async () => {
    const { deps } = await identityDeps(['owner-uuid']);
    for (let i = 0; i < 5; i++) {
      resolveQqIdentity(deps, { externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
    }
    const row = h!.app.repos.channelIdentities.findByUser(QQ_CHANNEL_NAME, 'owner-uuid');
    expect(row?.role).toBe('owner');
    expect(row?.last_seen_at).toBeTruthy();
  });
});