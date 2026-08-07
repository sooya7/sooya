import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

function stageCandidate(h: Harness): void {
  const oldUser = h.app.repos.messages.create({
    role: 'user',
    status: 'sent',
    parts: [{ type: 'text', text: '早上好' }]
  });
  h.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
    .run(localTime('2026-07-31T09:00').toISOString(), oldUser.message.id);

  h.app.repos.life.advance({
    activity: '去公园看猫',
    kind: 'out',
    mood: '好奇',
    startedAt: localTime('2026-07-31T14:00').toISOString(),
    endsAt: localTime('2026-07-31T17:00').toISOString()
  });
  h.app.repos.life.advance({
    activity: '练琴',
    kind: 'play',
    mood: '专注',
    startedAt: localTime('2026-07-31T17:00').toISOString(),
    endsAt: localTime('2026-07-31T18:00').toISOString()
  });
}

async function withReachOut(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  return await createHarness({
    ...options,
    env: {
      ENABLE_LIFE_ENGINE: 'true',
      ENABLE_LIFE_REACH_OUT: 'true',
      LIFE_QUIET_GAP_MINUTES: '60',
      ENABLE_BACKGROUND_JOBS: 'false',
      ADMIN_API_TOKEN: 'admin-test-token',
      ...options.env
    },
    chat: { script: [['刚刚去公园看猫，橘猫踩了我的鞋']], ...options.chat },
    startWorkers: false,
    clock: () => localTime('2026-07-31T17:30')
  });
}

describe('ProactiveComposer — coordinator scheduling (P0-1)', () => {
  it('aborts an in-flight proactive delivery when the user sends a message', async () => {
    harness = await withReachOut({ chat: { script: [['刚刚去公园看猫，橘猫踩了我的鞋'], ['回复用户']], delayMs: 800 } });
    stageCandidate(harness);
    const pending = harness.app.services.proactive.run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { clientMsgId: 'user-appeared-1', content: [{ type: 'text', text: '在吗' }] }
    });
    const result = await pending;
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('user_appeared');
    expect(result.messageId).toBeNull();
    const assistants = harness.app.repos.messages.recent(50).filter((m) => m.role === 'assistant' && m.meta?.proactive);
    expect(assistants).toHaveLength(0);
  });

  it('blocks a proactive delivery while a reply batch is open', async () => {
    harness = await withReachOut();
    stageCandidate(harness);
    const user = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '连续输入' }] }).message;
    harness.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(localTime('2026-07-31T16:00').toISOString(), user.id);
    harness.app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(Date.now() + 5000).toISOString(), new Date(Date.now() + 5000).toISOString());
    const result = await harness.app.services.proactive.run();
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('reply_in_progress');
  });

  it('P1-4: a second sender for the same candidate cannot mark its attempt sent', async () => {
    harness = await withReachOut();
    const msg = harness.app.repos.messages.create({ role: 'assistant', status: 'sent', parts: [{ type: 'text', text: '已发送' }] }).message;
    const first = harness.app.repos.proactive.create({ candidateId: 'cand-x', candidateKind: 'play', candidateActivity: '练琴', requestedMode: 'text', status: 'blocked', detail: {} });
    const second = harness.app.repos.proactive.create({ candidateId: 'cand-x', candidateKind: 'play', candidateActivity: '练琴', requestedMode: 'text', status: 'blocked', detail: {} });
    harness.app.repos.proactive.update(first.id, { status: 'sent', messageId: msg.id, sendSuccess: true });
    expect(() => harness.app.repos.proactive.update(second.id, { status: 'sent', messageId: msg.id, sendSuccess: true })).toThrow(/SQLITE_CONSTRAINT|UNIQUE/i);
  });
});

describe('ProactiveComposer', () => {
  it('blocks a candidate whose topic was recently discussed and records the reason', async () => {
    harness = await withReachOut();
    stageCandidate(harness);
    const recent = harness.app.repos.messages.create({
      role: 'assistant',
      status: 'sent',
      parts: [{ type: 'text', text: '我刚才还在公园看猫呢' }],
      meta: { proactive: false }
    });
    harness.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(localTime('2026-07-31T09:30').toISOString(), recent.message.id);
    const before = harness.app.repos.messages.count();

    const result = await harness.app.services.proactive.run();

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('recent_topic');
    expect(harness.app.repos.messages.count()).toBe(before);
    expect(harness.app.repos.proactive.list(1)[0]).toMatchObject({
      status: 'blocked',
      blockedReason: 'recent_topic',
      sendSuccess: false,
      candidateActivity: '去公园看猫'
    });
  });

  it.each([
    ['voice', { tts: 'fail' as const }],
    ['image', { image: 'fail' as const }]
  ] as const)('falls back from a failed %s candidate to text', async (mode, provider) => {
    harness = await withReachOut(provider);
    stageCandidate(harness);

    const result = await harness.app.services.proactive.run({ mode });
    const message = harness.app.repos.messages.get(result.messageId!);
    const attempt = harness.app.repos.proactive.list(1)[0]!;

    expect(result.status).toBe('sent');
    expect(result.requestedMode).toBe(mode);
    expect(result.finalMode).toBe('text');
    expect(result.sendSuccess).toBe(true);
    expect(message?.status).toBe('sent');
    expect(message?.content).toEqual([
      expect.objectContaining({ type: 'text', status: 'sent' })
    ]);
    expect(attempt).toMatchObject({
      requestedMode: mode,
      finalMode: 'text',
      fallbackReason: `${mode}_failed`,
      sendSuccess: true
    });
  });

  it.each([
    ['text_sticker', {}],
    ['voice', { tts: 'ok' as const }],
    ['image', { image: 'ok' as const }]
  ] as const)('persists a successful %s candidate', async (mode, provider) => {
    harness = await withReachOut(provider);
    stageCandidate(harness);

    const result = await harness.app.services.proactive.run({ mode });
    const message = harness.app.repos.messages.get(result.messageId!);

    expect(result.status).toBe('sent');
    expect(result.finalMode).toBe(mode);
    expect(result.sendSuccess).toBe(true);
    expect(message?.status).toBe('sent');
    expect(message?.content.some((part) => part.type === (mode === 'text_sticker' ? 'sticker' : mode === 'voice' ? 'audio' : 'image') && part.status === 'sent')).toBe(true);
  });

  it('marks the life candidate only after persistence and enqueues push.reply', async () => {
    harness = await withReachOut();
    stageCandidate(harness);

    const result = await harness.app.services.proactive.run({ mode: 'text' });
    const attempt = harness.app.repos.proactive.list(1)[0]!;
    const pushed = harness.app.repos.jobs.list(20).filter((job) => job.type === 'push.reply');

    expect(result.status).toBe('sent');
    expect(result.messageId).toBeTruthy();
    expect(harness.app.repos.messages.get(result.messageId!)?.status).toBe('sent');
    expect(harness.app.repos.life.events().some((event) => event.shared_at)).toBe(true);
    expect(attempt).toMatchObject({ finalMode: 'text', sendSuccess: true, messageId: result.messageId });
    expect(pushed).toHaveLength(1);
    expect(JSON.parse(pushed[0]!.payload_json)).toMatchObject({ messageId: result.messageId });
  });

  it('records a later user response in the admin-visible attempt record', async () => {
    harness = await withReachOut();
    stageCandidate(harness);
    const proactive = await harness.app.services.proactive.run({ mode: 'text' });
    harness.setChatScript([['收到啦']]);

    await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: { clientMsgId: 'proactive-response', content: [{ type: 'text', text: '我也想去看猫' }] }
    });

    const attempt = harness.app.repos.proactive.list(1)[0]!;
    const panel = await harness.app.server.inject({ method: 'GET', url: '/api/admin/life', headers: { 'x-admin-token': 'admin-test-token' } });
    expect(proactive.messageId).toBeTruthy();
    expect(attempt.userResponseMessageId).toEqual(expect.stringMatching(/^msg_/));
    expect(panel.statusCode).toBe(200);
    expect(panel.json().proactive[0]).toMatchObject({
      messageId: proactive.messageId,
      userResponseMessageId: attempt.userResponseMessageId
    });
  });
});
