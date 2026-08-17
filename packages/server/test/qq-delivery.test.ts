import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { JobWorker } from '../src/core/jobs.js';
import { registerDefaultJobs } from '../src/core/jobs.js';
import { QqApiClient } from '../src/channels/qq/client.js';
import { QqDeliveryService } from '../src/channels/qq/outbound.js';
import { qqBotConfigFromEnv } from '../src/channels/qq/config.js';
import { QQ_CHANNEL_NAME } from '../src/channels/qq/types.js';

let h: Harness;

afterEach(async () => {
  if (h) await h.cleanup();
});

const APP_ID = '102000000';

interface ScriptedResponse {
  status: number;
  body: Record<string, unknown>;
}

function mockFetch(script: Array<ScriptedResponse | 'timeout' | 'network'>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const tokenCalls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = String(url);
    calls.push({ url: raw, init });
    if (raw.includes('/getAppAccessToken')) {
      tokenCalls.push({ url: raw, body: init?.body });
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 7200 }), { status: 200 });
    }
    const next = script.shift() ?? { status: 200, body: { id: 'ROBOT1.0_ok' } };
    if (next === 'timeout') throw new DOMException('aborted', 'AbortError');
    if (next === 'network') throw new Error('fetch failed');
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fetchImpl, calls, tokenCalls };
}

function config() {
  return qqBotConfigFromEnv({
    QQ_APP_ID: APP_ID,
    QQ_APP_SECRET: 'app-secret',
    QQ_CALLBACK_SECRET: 'call-secret'
  });
}

async function buildDelivery(script: Array<ScriptedResponse | 'timeout' | 'network'> = []) {
  h = await createHarness({ startWorkers: false });
  const { fetchImpl, calls, tokenCalls } = mockFetch(script);
  const client = new QqApiClient(config(), { fetchImpl });
  const delivery = new QqDeliveryService({
    deliveries: h.app.repos.channelDeliveries,
    identities: h.app.repos.channelIdentities,
    events: h.app.repos.channelEvents,
    media: h.app.repos.media,
    mediaStore: h.app.services.mediaStore,
    messages: h.app.repos.messages,
    replyBatches: h.app.repos.replyBatches,
    jobs: h.app.repos.jobs,
    errors: h.app.repos.errors,
    client
  });
  // 绑定授权 owner（相当于 QQ 用户首次发消息后）。
  h.app.repos.channelIdentities.bindOwner({
    channel: QQ_CHANNEL_NAME,
    externalUserId: 'owner-uuid',
    externalConversationId: 'owner-uuid'
  });
  return { delivery, calls, tokenCalls, script };
}

async function assistantMessage(text: string, meta: Record<string, unknown> = {}) {
  const created = h!.app.repos.messages.create({
    role: 'assistant',
    status: 'sent',
    parts: [{ type: 'text', text }],
    meta: { ...meta, batchMessageIds: ['m-user-1'] }
  });
  return created.message;
}

describe('QQ delivery: sends', () => {
  it('sends a text reply and records the remote message id (proactive, no msg_id)', async () => {
    const { delivery, calls, tokenCalls } = await buildDelivery();
    const message = await assistantMessage('你好呀');
    const status = await delivery.deliver({ messageId: message.id });
    expect(status).toBe('sent');

    expect(tokenCalls).toHaveLength(1);
    const send = calls.find((c) => c.url.includes('/v2/users/owner-uuid/messages'));
    expect(send).toBeTruthy();
    const body = JSON.parse(String(send!.init!.body)) as { msg_type: number; content: string; msg_id?: string };
    expect(body).toMatchObject({ msg_type: 0, content: '你好呀' });
    expect(body.msg_id).toBeUndefined();

    const row = h!.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid');
    expect(row?.status).toBe('sent');
    expect(row?.remote_message_id).toBe('ROBOT1.0_ok');
    expect(row?.attempts).toBe(1);
  });

  it('uses passive reply msg_id when the assistant message replies to a QQ user message', async () => {
    const { delivery, calls } = await buildDelivery();
    // 模拟电脑已处理过一条 QQ 用户消息（channel_event 回填了 SOOYA message id）。
    const user = h!.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '在吗' }] }).message;
    h!.app.repos.channelEvents.markReceived({ channel: 'qq', eventId: 'evt-user', remoteMessageId: 'qq-msg-1', eventType: 'C2C_MESSAGE_CREATE', conversationKey: 'owner-uuid' });
    h!.app.repos.channelEvents.markProcessed('qq', 'evt-user', user.id);
    // assistant 回复挂在同一个 reply batch 上（触发消息 = 该 QQ 用户消息）。
    const admission = h!.app.repos.replyBatches.appendOrCreateMessage(user.id, new Date().toISOString(), new Date().toISOString());
    const message = await assistantMessage('在的');
    h!.app.db
      .prepare('INSERT INTO reply_batch_messages(batch_id, message_id, position, created_at) VALUES (?, ?, ?, ?)')
      .run(admission.batch.id, message.id, 1, new Date().toISOString());

    const status = await delivery.deliver({ messageId: message.id });
    expect(status).toBe('sent');
    const send = calls.find((c) => c.url.includes('/v2/users/owner-uuid/messages'));
    const body = JSON.parse(String(send!.init!.body)) as { msg_id?: string; msg_seq?: number };
    expect(body).toMatchObject({ msg_id: 'qq-msg-1', msg_seq: 1 });
  });
});

describe('QQ delivery: retry classification', () => {
  it('marks failed on a permanent 4xx and never re-enqueues', async () => {
    const { delivery, script } = await buildDelivery([{ status: 400, body: { err_code: 11253, message: 'app no privilege' } }]);
    const message = await assistantMessage('你好');
    const status = await delivery.deliver({ messageId: message.id });
    expect(status).toBe('failed');
    const row = h!.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid');
    expect(row?.status).toBe('failed');
    expect(row?.last_error_code).toBe('err_11253');
    expect(script).toHaveLength(0); // 没有再排队
    expect(h!.app.repos.jobs.list(20)).toHaveLength(0);
  });

  it('retries on 429 with backoff and re-enqueues a future qq.deliver job', async () => {
    const { delivery } = await buildDelivery([{ status: 429, body: { err_code: 0, message: 'rate limited' } }]);
    const message = await assistantMessage('你好');
    const status = await delivery.deliver({ messageId: message.id });
    expect(status).toBe('retry');
    const row = h!.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid');
    expect(row?.status).toBe('retry');
    expect(row?.attempts).toBe(1);
    expect(row?.next_retry_at).toBeTruthy();
    const jobs = h!.app.repos.jobs.list(20);
    const retryJob = jobs.find((j) => j.type === 'qq.deliver');
    expect(retryJob).toBeTruthy();
    expect(retryJob!.run_after).toBe(row!.next_retry_at);
  });

  it('treats network and timeout failures as retryable', async () => {
    const { delivery } = await buildDelivery(['timeout']);
    const message = await assistantMessage('你好');
    expect(await delivery.deliver({ messageId: message.id })).toBe('retry');
    h!.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid')!.status;
    expect(h!.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid')!.status).toBe('retry');
  });
});

describe('QQ delivery: idempotency and recovery', () => {
  it('never double-sends after a successful delivery', async () => {
    const { delivery, calls } = await buildDelivery();
    const message = await assistantMessage('你好');
    expect(await delivery.deliver({ messageId: message.id })).toBe('sent');
    const sendCount = calls.filter((c) => c.url.includes('/v2/users/owner-uuid/messages')).length;
    expect(await delivery.deliver({ messageId: message.id })).toBe('skipped');
    expect(calls.filter((c) => c.url.includes('/v2/users/owner-uuid/messages'))).toHaveLength(sendCount);
  });

  it('skips when no owner is bound yet', async () => {
    h = await createHarness({ startWorkers: false });
    const client = new QqApiClient(config(), { fetchImpl: mockFetch([]).fetchImpl });
    const delivery = new QqDeliveryService({
      deliveries: h.app.repos.channelDeliveries,
      identities: h.app.repos.channelIdentities,
      events: h.app.repos.channelEvents,
    media: h.app.repos.media,
    mediaStore: h.app.services.mediaStore,
      messages: h.app.repos.messages,
      replyBatches: h.app.repos.replyBatches,
      jobs: h.app.repos.jobs,
      errors: h.app.repos.errors,
      client
    });
    const message = await assistantMessage('你好');
    expect(await delivery.deliver({ messageId: message.id })).toBe('skipped');
    expect(h.app.repos.channelDeliveries.byMessageId(message.id)).toBeUndefined();
  });

  it('lets a stuck sending row recover after restart', async () => {
    const { delivery } = await buildDelivery();
    const message = await assistantMessage('你好');
    const { row } = h!.app.repos.channelDeliveries.enqueue({ channel: 'qq', messageId: message.id, externalConversationId: 'owner-uuid' });
    h!.app.repos.channelDeliveries.claim(row.id); // 模拟发送中断在 sending
    expect(h!.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid')!.status).toBe('sending');
    delivery.recoverInFlight();
    expect(h!.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid')!.status).toBe('pending');
    expect(h!.app.repos.channelDeliveries.dueNow('qq')).toHaveLength(1);
  });
});

describe('QQ delivery: via durable job', () => {
  it('the qq.deliver job drives the send when the worker runs', async () => {
    h = await createHarness({ startWorkers: false, env: { QQ_BOT_ENABLED: 'true' } });
    const { fetchImpl, calls } = mockFetch([]);
    const client = new QqApiClient(config(), { fetchImpl });
    const delivery = new QqDeliveryService({
      deliveries: h.app.repos.channelDeliveries,
      identities: h.app.repos.channelIdentities,
      events: h.app.repos.channelEvents,
    media: h.app.repos.media,
    mediaStore: h.app.services.mediaStore,
      messages: h.app.repos.messages,
      replyBatches: h.app.repos.replyBatches,
      jobs: h.app.repos.jobs,
      errors: h.app.repos.errors,
      client
    });
    h.app.repos.channelIdentities.bindOwner({ channel: QQ_CHANNEL_NAME, externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
    const message = await assistantMessage('你好');

    const worker = new JobWorker(h.app.repos.jobs, h.app.repos.errors, { intervalMs: 100 });
    registerDefaultJobs(worker, {
      jobs: h.app.repos.jobs,
      media: h.app.services.mediaStore,
      mediaText: h.app.repos.mediaText,
      memoryBackend: 'legacy',
      summarizer: h.app.services.summarizer,
      messages: h.app.repos.messages,
      bus: h.app.services.bus,
      backups: h.app.services.backups,
      life: h.app.services.life,
      presence: h.app.services.presence,
      batches: h.app.repos.replyBatches,
      proactive: h.app.services.proactive,
      capabilities: h.app.services.capabilities,
      stickerAnalyzer: h.app.services.stickerAnalyzer,
      stickerRepo: h.app.repos.stickers,
      stickerUserMeaning: h.app.services.stickerUserMeaning,
      config: h.app.config,
      reachOutEnabled: false,
      push: h.app.services.push,
      storage: h.app.services.storage,
      tmpDirs: [],
      qqDelivery: delivery
    });
    h.app.repos.jobs.enqueue('qq.deliver', { messageId: message.id });
    await worker.drain(5);

    expect(calls.filter((c) => c.url.includes('/v2/users/owner-uuid/messages'))).toHaveLength(1);
    expect(h.app.repos.channelDeliveries.find('qq', message.id, 'owner-uuid')?.status).toBe('sent');
    await worker.stop();
  });
});