import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

function sharePlan(text: string, image: { kind: 'pov' | 'selfie'; scene: string } | null = { kind: 'pov', scene: '社区公园步道旁一只橘猫看向手机镜头' }): string {
  return JSON.stringify({ text, image });
}

function asSharePlan(chunk: string): string {
  try {
    const value = JSON.parse(chunk) as { text?: unknown; image?: unknown };
    if (typeof value.text === 'string' && 'image' in value) return chunk;
  } catch { /* plain test text */ }
  return sharePlan(chunk);
}

function stageCandidate(h: Harness): void {
  const oldUser = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '早上好' }] });
  h.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(localTime('2026-07-31T09:00').toISOString(), oldUser.message.id);
  h.app.repos.life.advance({
    activity: '去公园看猫', kind: 'out', mood: '好奇',
    startedAt: localTime('2026-07-31T14:00').toISOString(),
    endsAt: localTime('2026-07-31T17:00').toISOString()
  });
  h.app.repos.life.advance({
    activity: '练琴', kind: 'play', mood: '专注',
    startedAt: localTime('2026-07-31T17:00').toISOString(),
    endsAt: localTime('2026-07-31T18:00').toISOString()
  });
}

async function withMoments(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
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
    chat: {
      ...options.chat,
      script: options.chat?.script?.map((chunks) => chunks.map(asSharePlan)) ?? [[sharePlan('公园那只橘猫今天格外黏人，踩着我的鞋不肯走。')]]
    },
    startWorkers: false,
    clock: () => localTime('2026-07-31T17:30')
  });
}

describe('ProactiveComposer -> Moments', () => {
  it('publishes a Life share as a Moment without inserting an assistant chat message or push job', async () => {
    harness = await withMoments();
    stageCandidate(harness);
    const beforeAssistant = harness.app.repos.messages.recent(50).filter((message) => message.role === 'assistant').length;

    const result = await harness.app.services.proactive.run({ mode: 'text' });

    expect(result.status).toBe('sent');
    expect(result.messageId).toBeNull();
    expect(result.momentId).toEqual(expect.stringMatching(/^moment_/));
    expect(harness.app.repos.moments.get(result.momentId!)).toMatchObject({
      activity: '去公园看猫',
      image_media_id: null
    });
    expect(harness.app.repos.messages.recent(50).filter((message) => message.role === 'assistant')).toHaveLength(beforeAssistant);
    expect(harness.app.repos.jobs.list(20).filter((job) => job.type === 'push.reply')).toHaveLength(0);
    expect(harness.app.repos.proactive.list(1)[0]).toMatchObject({ status: 'sent', messageId: null, momentId: result.momentId, sendSuccess: true });
    expect(harness.app.repos.life.events().some((event) => event.shared_at)).toBe(true);
  });

  it('does not require the user to have been quiet before posting a Moment', async () => {
    harness = await withMoments();
    stageCandidate(harness);
    const recent = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '我回来啦' }] }).message;
    harness.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(localTime('2026-07-31T17:20').toISOString(), recent.id);

    const evaluation = harness.app.services.proactive.evaluate();
    expect(evaluation.reach).toBe(true);
    expect(evaluation.reason).toBe('ok');
  });

  it('still yields to an active user reply batch so chat keeps provider priority', async () => {
    harness = await withMoments();
    stageCandidate(harness);
    const user = harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '连续输入' }] }).message;
    harness.app.repos.replyBatches.appendOrCreateMessage(user.id, new Date(Date.now() + 5000).toISOString(), new Date(Date.now() + 5000).toISOString());

    const result = await harness.app.services.proactive.run();
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('reply_in_progress');
    expect(harness.app.repos.moments.list()).toHaveLength(0);
  });

  it.each(['voice', 'text_sticker'] as const)('normalizes legacy %s proactive mode to a text Moment', async (mode) => {
    harness = await withMoments();
    stageCandidate(harness);
    const result = await harness.app.services.proactive.run({ mode });
    expect(result.status).toBe('sent');
    expect(result.requestedMode).toBe('text');
    expect(result.finalMode).toBe('text');
    expect(harness.app.repos.moments.get(result.momentId!)?.image_media_id).toBeNull();
  });

  it('plans a grounded POV photo and stores it as a Moment media reference', async () => {
    harness = await withMoments({ image: 'ok' });
    stageCandidate(harness);
    const park = harness.app.repos.locations.create({ name: '社区公园', kind: 'park', city: '宁波', source: 'admin' });
    harness.app.repos.locations.recordVisit({ locationId: park.id, enteredAt: localTime('2026-07-31T14:00').toISOString(), leftAt: localTime('2026-07-31T17:00').toISOString() });

    const result = await harness.app.services.proactive.run({ mode: 'image' });
    expect(result.status).toBe('sent');
    expect(result.finalMode).toBe('image');
    const moment = harness.app.repos.moments.get(result.momentId!)!;
    expect(moment.location_name).toBe('社区公园');
    expect(moment.city).toBe('宁波');
    expect(moment.image_media_id).toBeTruthy();
    expect(harness.app.repos.media.references(moment.image_media_id!)).toMatchObject({ moments: 1, total: 1 });
    const prompt = JSON.stringify(harness.state.imageRequests[0]!.body);
    expect(prompt).toContain('社区公园');
    expect(prompt).toContain('橘猫');
    expect(harness.state.imageRequests[0]!.body.input_images).toBeUndefined();
  });

  it('uses persona references only for a selfie Moment', async () => {
    harness = await withMoments({
      image: 'anuma',
      chat: { script: [[sharePlan('窗边这杯咖啡意外地好喝，今天的光也很舒服。', { kind: 'selfie', scene: '咖啡店窗边的 SOOYA 举着咖啡杯看向手机' })]] }
    });
    stageCandidate(harness);
    const result = await harness.app.services.proactive.run({ mode: 'image' });
    expect(result.status).toBe('sent');
    expect(harness.state.imageRequests[0]!.body.input_images).toBeDefined();
    expect(harness.app.repos.proactive.list(1)[0]!.detail).toMatchObject({ photoKind: 'selfie', referenceUsed: true, destination: 'moments' });
  });

  it('repairs an incomplete Moment caption once and refuses a second invalid caption', async () => {
    harness = await withMoments({ chat: { script: [[JSON.stringify({ text: '刚刚', image: null })], [JSON.stringify({ text: '路边的猫盯了我好久，尾巴还扫到了鞋边。', image: null })]] } });
    stageCandidate(harness);
    const result = await harness.app.services.proactive.run({ mode: 'text' });
    expect(harness.app.repos.moments.get(result.momentId!)?.text).toContain('路边的猫');
    await harness.cleanup();
    harness = null;

    harness = await withMoments({ chat: { script: [[JSON.stringify({ text: '刚刚', image: null })], [JSON.stringify({ text: '刚发生的事：', image: null })]] } });
    stageCandidate(harness);
    const blocked = await harness.app.services.proactive.run({ mode: 'text' });
    expect(blocked.status).toBe('failed');
    expect(blocked.blockedReason).toBe('invalid_share_text');
    expect(harness.app.repos.moments.list()).toHaveLength(0);
  });

  it('exposes Moments through the chat-token API and supports liking', async () => {
    harness = await withMoments();
    stageCandidate(harness);
    const posted = await harness.app.services.proactive.run({ mode: 'text' });

    const list = await harness.app.server.inject({ method: 'GET', url: '/api/moments' });
    expect(list.statusCode).toBe(200);
    expect(list.json().moments[0]).toMatchObject({ id: posted.momentId, liked: false, activity: '去公园看猫' });

    const liked = await harness.app.server.inject({ method: 'PATCH', url: `/api/moments/${posted.momentId}/like`, payload: { liked: true } });
    expect(liked.statusCode).toBe(200);
    expect(liked.json().moment.liked).toBe(true);
  });

  it('aborts an in-flight Moment composition when a user reply takes provider priority, then leaves the candidate unshared', async () => {
    harness = await withMoments({ chat: { script: [['公园那只猫今天一直跟着我走。'], ['回复用户']], delayMs: 800 } });
    stageCandidate(harness);
    const pending = harness.app.services.proactive.run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await harness.app.server.inject({ method: 'POST', url: '/api/messages', payload: { clientMsgId: 'user-appeared-1', content: [{ type: 'text', text: '在吗' }] } });
    const result = await pending;
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('user_appeared');
    expect(harness.app.repos.moments.list()).toHaveLength(0);
    await vi.waitFor(() => expect(harness!.app.repos.replyBatches.openBatch()).toBeUndefined(), { timeout: 10_000 });
  });
});
