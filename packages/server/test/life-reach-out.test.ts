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

/**
 * The point of the whole feature: she can open her mouth without being asked.
 * These drive the real `life.tick` job through the real worker, so the wiring
 * -- job registration, message insert, SSE event, push enqueue -- is covered
 * rather than just the policy object.
 */
describe('she speaks first', () => {
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
      // 17:30 her time: awake, mid-afternoon, well past the quiet gap.
      clock: () => localTime('2026-07-31T17:30')
    });
  }

  /** An old user message plus a finished activity she has not mentioned. */
  function stage(h: Harness): void {
    // Long before the pinned clock, so she is not interrupting anyone.
    const old = localTime('2026-07-31T09:00').toISOString();
    h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '我去睡了' }] });
    h.app.db.raw.prepare('UPDATE messages SET created_at = ?').run(old);

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

  it('writes an assistant message, marks it proactive and queues a push', async () => {
    harness = await withReachOut('刚在公园蹲了半天看猫，有只橘猫一直踩我鞋');
    stage(harness);
    const before = harness.app.repos.messages.count();

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);

    expect(harness.app.repos.messages.count()).toBe(before + 1);
    const latest = harness.app.repos.messages.recent(1)[0]!;
    expect(latest.role).toBe('assistant');
    expect(latest.meta.proactive).toBe(true);
    expect(latest.content[0]!.text).toContain('橘猫');

    // The user must be told even with the app closed, which is the only way an
    // unprompted message is worth anything.
    const queued = harness.app.repos.jobs.list(20).filter((job) => job.type === 'push.reply');
    expect(queued).toHaveLength(1);

    // And it must reach a client that is currently open.
    const events = harness.app.repos.events.since(0, 50);
    expect(events.some((event) => event.type === 'message.received')).toBe(true);
  });

  it('does not pile a second unprompted message on the first', async () => {
    harness = await withReachOut('公园的猫踩我鞋');
    stage(harness);

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    const firstCount = harness.app.repos.messages.count();
    expect(firstCount).toBe(2);

    /*
     * The repositories stamp rows with the real clock while the life engine
     * reads the injected one. In production both are the same clock, so this
     * only diverges under test; pinning the row she just wrote to the pinned
     * clock is what makes the `already_spoke` guard observable here.
     */
    const written = harness.app.repos.messages.recent(1)[0]!;
    harness.app.db.raw.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(localTime('2026-07-31T17:25').toISOString(), written.id);

    harness.app.repos.jobs.enqueue('life.tick', {});
    await harness.app.services.worker.drain(5);
    expect(harness.app.repos.messages.count()).toBe(firstCount);
  });

  it('stays quiet when the feature is off', async () => {
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

    // The tick still advances her state; only the talking is gated.
    expect(harness.app.repos.messages.count()).toBe(before);
    expect(harness.app.repos.life.current()).toBeDefined();
  });

  it('stays quiet while the user is still around', async () => {
    harness = await withReachOut('不该发出来的话');
    harness.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '在吗' }] });
    // 30 minutes before the pinned clock, inside the 60-minute quiet gap.
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

    expect(harness.app.repos.messages.count()).toBe(before);
  });
});
