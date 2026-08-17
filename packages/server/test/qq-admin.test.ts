import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { QQ_CHANNEL_NAME } from '../src/channels/qq/types.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };

async function qqAdminHarness(overrides: Record<string, string> = {}) {
  h = await createHarness({
    startWorkers: false,
    skipStickerImport: true,
    env: {
      ADMIN_API_TOKEN: ADMIN['x-admin-token'],
      QQ_BOT_ENABLED: 'true',
      QQ_APP_ID: '102000000',
      QQ_APP_SECRET: 'app-secret',
      QQ_CALLBACK_SECRET: 'call-secret',
      QQ_ALLOWED_USERS: 'owner-uuid',
      METRICS_DASHBOARD_ENABLED: 'true',
      ...overrides
    }
  });
  return h;
}

function adminGet(path: string) {
  return h!.app.server.inject({ method: 'GET', url: path, headers: ADMIN });
}

describe('QQ admin API (PR 6)', () => {
  it('reports channel status with counts, owner and credential summary (no secrets)', async () => {
    h = await qqAdminHarness();
    h.app.repos.channelIdentities.bindOwner({ channel: QQ_CHANNEL_NAME, externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
    h.app.repos.channelDeliveries.enqueue({ channel: 'qq', messageId: 'm-1', externalConversationId: 'owner-uuid' });
    h.app.repos.channelDeliveries.enqueue({ channel: 'qq', messageId: 'm-2', externalConversationId: 'owner-uuid' });

    const res = await adminGet('/api/admin/qq/status');
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.enabled).toBe(true);
    expect(body.credentialConfigured).toBe(true);
    expect(body.appIdSummary).not.toContain('app-secret');
    expect(JSON.stringify(body)).not.toContain('app-secret');
    expect(JSON.stringify(body)).not.toContain('call-secret');
    expect(body.owner?.externalUserId).toBe('owner-uuid');
    expect(body.counts).toMatchObject({ pending: 2, sent: 0, failed: 0 });
  });

  it('requires the admin token (401 without it)', async () => {
    h = await qqAdminHarness();
    const res = await h.app.server.inject({ method: 'GET', url: '/api/admin/qq/status' });
    expect(res.statusCode).toBe(401);
  });

  it('lists inbound events without exposing anything sensitive', async () => {
    h = await qqAdminHarness();
    h.app.repos.channelEvents.markReceived({ channel: 'qq', eventId: 'evt-1', remoteMessageId: 'msg-1', eventType: 'C2C_MESSAGE_CREATE', conversationKey: 'owner-uuid' });
    h.app.repos.channelEvents.markProcessed('qq', 'evt-1', 'sooya-msg-1');

    const res = await adminGet('/api/admin/qq/events');
    const body = res.json() as any;
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ eventId: 'evt-1', eventType: 'C2C_MESSAGE_CREATE', status: 'processed', messageId: 'sooya-msg-1' });
  });

  it('lists deliveries and retries a failed one back to pending', async () => {
    h = await qqAdminHarness();
    const { row } = h.app.repos.channelDeliveries.enqueue({ channel: 'qq', messageId: 'm-retry', externalConversationId: 'owner-uuid' });
    h.app.repos.channelDeliveries.markFailed(row.id, 'http_500', 'boom');

    const list = await adminGet('/api/admin/qq/deliveries?status=failed');
    const listBody = list.json() as any;
    expect(listBody.deliveries).toHaveLength(1);
    expect(listBody.deliveries[0].lastErrorCode).toBe('http_500');

    const retry = await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/qq/deliveries/${row.id}/retry`,
      headers: ADMIN
    });
    expect(retry.statusCode).toBe(200);
    expect(h.app.repos.channelDeliveries.getById(row.id)?.status).toBe('pending');
    const jobs = h.app.repos.jobs.list(20);
    expect(jobs.some((job) => job.type === 'qq.deliver' && job.payload_json.includes('m-retry'))).toBe(true);
  });

  it('refuses to retry a delivery that is not failed or retrying', async () => {
    h = await qqAdminHarness();
    const { row } = h.app.repos.channelDeliveries.enqueue({ channel: 'qq', messageId: 'm-sent', externalConversationId: 'owner-uuid' });
    h.app.repos.channelDeliveries.markSent(row.id, 'remote-ok');

    const res = await h.app.server.inject({ method: 'POST', url: `/api/admin/qq/deliveries/${row.id}/retry`, headers: ADMIN });
    expect(res.statusCode).toBe(409);
  });

  it('test-send without a bound owner reports a safe error without touching the network', async () => {
    h = await qqAdminHarness();
    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/admin/qq/test-send',
      headers: ADMIN,
      payload: { content: '测试消息' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.ok).toBe(false);
    expect(body.errorCode).toBe('no_owner_bound');
  });

  it('filters the error digest to qq.* scope only', async () => {
    h = await qqAdminHarness();
    h.app.repos.errors.add('qq.verify', 'signature rejected', { code: 'signature_invalid' });
    h.app.repos.errors.add('http.unexpected', 'unrelated failure', {});

    const res = await adminGet('/api/admin/qq/errors');
    const body = res.json() as any;
    expect(body.errors.every((entry: { scope: string }) => entry.scope.startsWith('qq.'))).toBe(true);
    expect(body.errors.length).toBe(1);
  });
});