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

/**
 * Life still decides when an event is worth sharing, but the delivery target is
 * now the private Moments feed. Drive the real `life.tick` job through the real
 * worker so job registration, Moment persistence and stream delivery are all
 * covered without falling back to the old assistant-message path.
 */
describe('Life shares become Moments', () => {
  async function withReachOut(chatText: string) {
    return await createHarness({
      env: {
        ENABLE_LIFE_ENGINE: 'true',
        ENABLE_LIFE_REACH_OUT: 'true',
        LIFE_QUIET_GAP_MINUTES: '60',
        ENABLE_BACKGROUND_JOBS: 'false'
      },
      chat: { script: [[sharePlan(chatText)]] },
      startWorkers: false,
      clock: () => localTime('2026-07-31T17:30')
    });
  }

  /** An old user message plus a finished activity she has not shared. */
  function stage(h: Harness): void {
    const old = localTime('2026-07-31T09:00').toISOString();
    const user = h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '我去睡了' }] }).message;
    h.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(old, user.id);

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

  it('publishes a Moment without inserting an assistant message or queuing reply push', async () => {
    harness = await withReachOut('刚在公园蹲了半天看猫，有只橘猫一直踩我鞋。');
    stage(harness);
    const beforeMessages = harness.app.repos.messages.count();
    const beforeMoments = harness.app.repos.moments.list().length;

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.moments.list().length === beforeMoments + 1);

    expect(harness.app.repos.messages.count()).toBe(beforeMessages);
    const moments = harness.app.repos.moments.list();
    expect(moments).toHaveLength(beforeMoments + 1);
    expect(moments[0]).toMatchObject({ activity: '去公园看猫' });
    expect(moments[0]!.text).toContain('橘猫');

    const queuedPushes = harness.app.repos.jobs.list(20).filter((job) => job.type === 'push.reply');
    expect(queuedPushes).toHaveLength(0);

    const attempt = harness.app.repos.proactive.list(1)[0]!;
    expect(attempt).toMatchObject({ status: 'sent', messageId: null, momentId: moments[0]!.id, sendSuccess: true });

    const events = harness.app.repos.events.since(0, 50);
    expect(events.some((event) => event.type === 'moment.created')).toBe(true);
  });

  it('does not publish the same finished Life event twice', async () => {
    harness = await withReachOut('公园的猫踩我鞋。');
    stage(harness);

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.moments.list().length === 1);
    expect(harness.app.repos.moments.list()).toHaveLength(1);
    const messageCount = harness.app.repos.messages.count();
    const attemptCount = harness.app.repos.proactive.list(50).length;

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.proactive.list(50).length > attemptCount);

    expect(harness.app.repos.moments.list()).toHaveLength(1);
    expect(harness.app.repos.messages.count()).toBe(messageCount);
  });

  it('does not publish when the feature is off', async () => {
    harness = await createHarness({
      env: { ENABLE_LIFE_ENGINE: 'true', ENABLE_LIFE_REACH_OUT: 'false', ENABLE_BACKGROUND_JOBS: 'false' },
      chat: { script: [[sharePlan('不该发出来的话')]] },
      startWorkers: false,
      clock: () => localTime('2026-07-31T17:30')
    });
    stage(harness);
    const before = harness.app.repos.messages.count();

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);

    expect(harness.app.repos.messages.count()).toBe(before);
    expect(harness.app.repos.moments.list()).toHaveLength(0);
    expect(harness.app.repos.life.current()).toBeDefined();
  });

  it('can publish a Moment while the user is recently active because it no longer interrupts chat', async () => {
    harness = await withReachOut('公园那只猫一直跟着我走，最后还蹭了蹭鞋边。');
    harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '在吗' }] });
    harness.app.db.raw.prepare('UPDATE messages SET created_at = ?').run(localTime('2026-07-31T17:00').toISOString());
    harness.app.repos.life.advance({
      activity: '去公园看猫', kind: 'out', mood: '好奇',
      startedAt: localTime('2026-07-31T14:00').toISOString(),
      endsAt: localTime('2026-07-31T17:00').toISOString()
    });
    harness.app.repos.life.advance({
      activity: '练琴', kind: 'play', mood: '专注',
      startedAt: localTime('2026-07-31T17:00').toISOString(),
      endsAt: localTime('2026-07-31T18:00').toISOString()
    });
    const before = harness.app.repos.messages.count();

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    await waitUntil(() => harness!.app.repos.moments.list().length === 1);

    expect(harness.app.repos.messages.count()).toBe(before);
    expect(harness.app.repos.moments.list()).toHaveLength(1);
  });
});