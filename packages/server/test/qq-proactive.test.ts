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

function sharePlan(text: string): string {
  return JSON.stringify({ text, image: null });
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for detached proactive work');
}

async function withReachOut(chatText: string, qqEnabled: boolean) {
  harness = await createHarness({
    env: {
      ENABLE_LIFE_ENGINE: 'true',
      ENABLE_LIFE_REACH_OUT: 'true',
      LIFE_QUIET_GAP_MINUTES: '60',
      ENABLE_BACKGROUND_JOBS: 'false',
      ...(qqEnabled ? { QQ_BOT_ENABLED: 'true', QQ_APP_ID: '102000000', QQ_APP_SECRET: 's', QQ_CALLBACK_SECRET: 'c', QQ_ALLOWED_USERS: 'owner-uuid' } : {})
    },
    chat: { script: [[sharePlan(chatText)]] },
    startWorkers: false,
    clock: () => localTime('2026-07-31T17:30')
  });
  return harness;
}

/** 旧用户消息 + 一条已完成未分享的活动（驱动 shouldReachOut 通过）。 */
function stage(): void {
  const old = localTime('2026-07-31T09:00').toISOString();
  const user = harness!.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '我去睡了' }] }).message;
  harness!.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(old, user.id);
  harness!.app.repos.life.advance({
    activity: '去公园看猫', kind: 'out', mood: '好奇',
    startedAt: localTime('2026-07-31T14:00').toISOString(),
    endsAt: localTime('2026-07-31T17:00').toISOString()
  });
  harness!.app.repos.channelIdentities.bindOwner({ channel: 'qq', externalUserId: 'owner-uuid', externalConversationId: 'owner-uuid' });
}

describe('QQ proactive delivery (PR 5)', () => {
  it('turns a shared Moment into an assistant message and queues qq.deliver when QQ is enabled', async () => {
    harness = await withReachOut('刚去公园看猫，有只橘猫一直踩我鞋。', true);
    stage();
    const beforeMessages = harness.app.repos.messages.count();

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.moments.list().length === 1
      && harness!.app.repos.messages.page(50).messages.some((m) => m.role === 'assistant' && m.meta?.proactive === true));

    // Moment 仍持久化（Admin 可观察）。
    const moments = harness.app.repos.moments.list();
    expect(moments).toHaveLength(1);
    expect(moments[0]!.text).toContain('橘猫');

    // 额外发布了一条可投递的 assistant 消息。
    const messages = harness.app.repos.messages.page(50).messages;
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    const proactive = messages.find((m) => m.role === 'assistant' && m.meta?.proactive === true);
    expect(proactive).toBeTruthy();
    expect(messages.length).toBe(beforeMessages + 1);

    // qq.deliver job 已入队（worker 关着，任务留在队列）。
    const jobs = harness.app.repos.jobs.list(20);
    const deliver = jobs.find((job) => job.type === 'qq.deliver');
    expect(deliver).toBeTruthy();

    // attempt 记下了 proactive message id。
    const attempt = harness.app.repos.proactive.list(1)[0]!;
    expect(attempt).toMatchObject({ status: 'sent', messageId: proactive!.id });
  });

  it('keeps Moments-only behavior when QQ is disabled (no assistant message)', async () => {
    harness = await withReachOut('刚去公园看猫。', false);
    stage();
    const beforeMessages = harness.app.repos.messages.count();

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.moments.list().length === 1);

    expect(harness.app.repos.moments.list()).toHaveLength(1);
    expect(harness.app.repos.messages.count()).toBe(beforeMessages);
    expect(harness.app.repos.jobs.list(20).filter((job) => job.type === 'qq.deliver')).toHaveLength(0);
  });

  it('writes a private message to the user with the recent conversation in view', async () => {
    harness = await withReachOut('下午去公园看猫了，有只橘猫一直踩我鞋，好想让你也摸摸。', true);
    stage();

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.messages.page(50).messages.some((m) => m.meta?.proactive === true));

    const prompt = JSON.stringify(harness.state.chatCalls[0]!.body);
    expect(prompt).toContain('只发给对方一个人');
    expect(prompt).toContain('对方：我去睡了');
    expect(prompt).toContain('对方上一次说话是约 9 小时前');
    expect(prompt).not.toContain('这里不是私人聊天窗口');
  });

  it('carries stage summaries and long-term memory into the private message', async () => {
    harness = await withReachOut('你上次说的面试准备得怎么样啦？', true);
    stage();
    harness.app.repos.summaries.create({ fromSeq: 1, toSeq: 1, content: '- 用户说下周要去面试，有点紧张。' });
    harness.app.repos.memories.upsert({ kind: 'profile', content: '用户睡前习惯说我去睡了，喜欢猫', importance: 0.9 });

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.messages.page(50).messages.some((m) => m.meta?.proactive === true));

    const prompt = JSON.stringify(harness.state.chatCalls[0]!.body);
    expect(prompt).toContain('你们以前聊过的重点');
    expect(prompt).toContain('用户说下周要去面试，有点紧张。');
    expect(prompt).toContain('你记得的关于对方');
    expect(prompt).toContain('喜欢猫');
  });

  it('still sends when the memory source fails', async () => {
    harness = await withReachOut('刚去公园看猫。', true);
    stage();
    const recall = vi.spyOn(harness.app.services.memory, 'recall').mockRejectedValue(new Error('memory down'));

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.messages.page(50).messages.some((m) => m.meta?.proactive === true));

    expect(recall).toHaveBeenCalled();
    expect(JSON.stringify(harness.state.chatCalls[0]!.body)).not.toContain('你记得的关于对方');
  });

  it('stops sharing after two unanswered proactive messages until the user replies', async () => {
    harness = await withReachOut('刚去公园看猫。', true);
    stage();
    for (const text of ['在忙吗～', '今天好安静呀']) {
      harness.app.repos.messages.create({ role: 'assistant', status: 'sent', parts: [{ type: 'text', text }], meta: { proactive: true } });
    }

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.proactive.list(20).length > 0);

    expect(harness.app.repos.proactive.list(1)[0]).toMatchObject({ status: 'blocked', blockedReason: 'awaiting_reply' });
    expect(harness.app.repos.moments.list()).toHaveLength(0);
  });

  it('waits twice as long while her last proactive message is unanswered', async () => {
    harness = await withReachOut('刚去公园看猫。', true);
    stage();
    // 100 min ago: past the jittered 60–96 min gap, inside the doubled one.
    harness.app.repos.moments.create({
      candidateId: 'life-earlier', text: '练了一下午琴', imageMediaId: null, imageKind: null, activity: '练琴',
      locationId: null, locationName: null, city: null, weatherCondition: null, temperatureC: null,
      createdAt: localTime('2026-07-31T15:50').toISOString()
    });
    harness.app.repos.messages.create({ role: 'assistant', status: 'sent', parts: [{ type: 'text', text: '在忙吗～' }], meta: { proactive: true } });

    expect(harness.app.services.proactive.evaluate()).toMatchObject({ reach: false, reason: 'moment_gap', unansweredProactive: 1 });

    harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '刚看到' }] });
    const answered = harness.app.services.proactive.evaluate();
    expect(answered.unansweredProactive).toBe(0);
    expect(answered.reason).not.toBe('moment_gap');
  });

  it('delays a proactive reach-out while a QQ delivery is still in flight', async () => {
    harness = await withReachOut('刚去公园看猫。', true);
    stage();

    // 造一条在途投递（pending）。
    harness.app.repos.channelDeliveries.enqueue({ channel: 'qq', messageId: 'msg-inflight', externalConversationId: 'owner-uuid' });

    // 第一个 life.tick：candidate 已就绪，但 evaluate 撞上在途投递 → 不发表内容。
    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.proactive.list(20).length > 0);
    expect(harness.app.repos.moments.list()).toHaveLength(0);
    const attempt = harness.app.repos.proactive.list(20)[0]!;
    expect(attempt).toMatchObject({ status: 'blocked', blockedReason: 'qq_delivery_in_flight' });

    // 投递完成后第二个 life.tick：正常产出 Moment + 主动消息。
    harness.app.repos.channelDeliveries.markSent(
      harness.app.repos.channelDeliveries.find('qq', 'msg-inflight', 'owner-uuid')!.id,
      'remote-1'
    );
    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.moments.list().length === 1
      && harness!.app.repos.messages.page(50).messages.some((m) => m.role === 'assistant'));
    expect(harness.app.repos.moments.list()).toHaveLength(1);
    expect(harness.app.repos.messages.page(50).messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
});