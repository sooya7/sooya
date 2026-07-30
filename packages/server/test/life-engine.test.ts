import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { LifeEngine, DEFAULT_LIFE_CONFIG, resolveActivity, isSilentHour } from '../src/core/life.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

/** UTC instant for a given wall-clock time in her timezone (UTC+8). */
function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

function engineAt(harnessRef: Harness, clock: () => Date, overrides: Partial<typeof DEFAULT_LIFE_CONFIG> = {}): LifeEngine {
  return new LifeEngine(harnessRef.app.repos.life, { ...DEFAULT_LIFE_CONFIG, ...overrides }, clock);
}

describe('life routine resolves from the clock alone', () => {
  it('puts her asleep at 03:00 and out in the afternoon', () => {
    expect(resolveActivity(localTime('2026-07-31T03:00')).kind).toBe('sleep');
    expect(resolveActivity(localTime('2026-07-31T14:30')).kind).toBe('out');
    expect(resolveActivity(localTime('2026-07-31T12:10')).kind).toBe('meal');
    expect(resolveActivity(localTime('2026-07-31T20:45')).kind).toBe('play');
  });

  it('uses her timezone, not the server timezone', () => {
    // 01:00 UTC is 09:00 for her: breakfast, not deep sleep. A server running
    // in UTC would otherwise report her asleep all morning.
    const at = new Date('2026-07-31T01:00:00Z');
    expect(resolveActivity(at).kind).toBe('meal');
    expect(resolveActivity(at, { ...DEFAULT_LIFE_CONFIG, tzOffsetMinutes: 0 }).kind).toBe('sleep');
  });

  it('reports slot boundaries as absolute instants', () => {
    const resolved = resolveActivity(localTime('2026-07-31T15:20'));
    expect(resolved.startedAt.toISOString()).toBe(localTime('2026-07-31T14:00').toISOString());
    expect(resolved.endsAt.toISOString()).toBe(localTime('2026-07-31T17:00').toISOString());
  });

  it('carries the last slot of the day over midnight', () => {
    const resolved = resolveActivity(localTime('2026-07-31T23:30'));
    expect(resolved.kind).toBe('sleep');
    // Ends when the next day's first slot opens, not at 24:00.
    expect(resolved.endsAt.toISOString()).toBe(localTime('2026-08-01T00:00').toISOString());
  });

  it('is stable within a day and varies across days', () => {
    const first = resolveActivity(localTime('2026-07-31T20:10')).activity;
    const again = resolveActivity(localTime('2026-07-31T21:50')).activity;
    expect(again).toBe(first);

    /*
     * Asserting merely "more than one" was too weak: a single-multiply hash put
     * consecutive days in the same bucket, so she ate the same breakfast every
     * morning and this still passed. Over ten days a four-option slot has to
     * actually use most of its options.
     */
    const tenDays = new Set(
      Array.from({ length: 10 }, (_, i) => resolveActivity(localTime(`2026-08-${String(i + 1).padStart(2, '0')}T20:10`)).activity)
    );
    expect(tenDays.size).toBeGreaterThanOrEqual(3);

    const mornings = new Set(
      Array.from({ length: 10 }, (_, i) => resolveActivity(localTime(`2026-08-${String(i + 1).padStart(2, '0')}T09:10`)).activity)
    );
    expect(mornings.size).toBeGreaterThanOrEqual(2);
  });

  it('knows when she is asleep for messaging purposes', () => {
    expect(isSilentHour(localTime('2026-07-31T04:00'))).toBe(true);
    expect(isSilentHour(localTime('2026-07-31T15:00'))).toBe(false);
  });
});

describe('life state advances and records history', () => {
  it('is idempotent inside one slot and files history on the boundary', async () => {
    harness = await createHarness();
    let now = localTime('2026-07-31T14:10');
    const life = engineAt(harness, () => now);

    const first = life.tick();
    expect(first.changed).toBe(true);

    // Same slot: nothing new, and no second history row.
    const second = life.tick();
    expect(second.changed).toBe(false);
    expect(harness.app.repos.life.recent(10)).toHaveLength(0);

    now = localTime('2026-07-31T17:30');
    const third = life.tick();
    expect(third.changed).toBe(true);
    expect(third.kind).toBe('play');

    const log = harness.app.repos.life.recent(10);
    expect(log).toHaveLength(1);
    expect(log[0]!.activity).toBe(first.activity);
    // Closed at the boundary, not at the moment the late tick ran.
    expect(log[0]!.ended_at).toBe(localTime('2026-07-31T17:00').toISOString());
  });

  it('recovers after missed ticks instead of staying in yesterday', async () => {
    harness = await createHarness();
    let now = localTime('2026-07-30T10:00');
    const life = engineAt(harness, () => now);
    life.tick();

    // Process was down for a day; one tick is enough to be correct again.
    now = localTime('2026-07-31T20:30');
    const result = life.tick();
    expect(result.changed).toBe(true);
    expect(result.kind).toBe('play');
    expect(harness.app.repos.life.current()!.activity).toBe(result.activity);
  });
});

describe('life context lines given to the prompt', () => {
  it('states the time, the activity and how long the user has been away', async () => {
    harness = await createHarness();
    const now = localTime('2026-07-31T20:30');
    const life = engineAt(harness, () => now);
    life.tick();

    const lines = life.contextLines(localTime('2026-07-31T17:30')).join('\n');
    expect(lines).toContain('7月31日 20:30');
    expect(lines).toContain('已经 30 分钟');
    expect(lines).toContain('距离你们上次说话过了 3 小时');
    expect(lines).toContain('不要临时编造');
  });

  it('says nothing about a gap when the user never left', async () => {
    harness = await createHarness();
    const life = engineAt(harness, () => localTime('2026-07-31T20:30'));
    expect(life.contextLines(null).join('\n')).not.toContain('距离你们上次说话');
  });
});

describe('speaking first is refused unless every condition holds', () => {
  async function ready(clock: () => Date, overrides: Partial<typeof DEFAULT_LIFE_CONFIG> = {}) {
    harness = await createHarness();
    const life = engineAt(harness, clock, overrides);
    // Give her a finished activity worth mentioning.
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
    return life;
  }

  it('reaches out when she has something to say and the user has been quiet', async () => {
    const life = await ready(() => localTime('2026-07-31T17:30'));
    const decision = life.shouldReachOut(localTime('2026-07-31T09:00'), null);
    expect(decision.reach).toBe(true);
    expect(decision.candidate!.activity).toBe('去公园看猫');
  });

  it('stays silent while she is asleep', async () => {
    const life = await ready(() => localTime('2026-08-01T04:00'));
    expect(life.shouldReachOut(localTime('2026-07-31T09:00'), null).reason).toBe('silent_hours');
  });

  it('stays silent when the user was just here', async () => {
    const life = await ready(() => localTime('2026-07-31T17:30'));
    expect(life.shouldReachOut(localTime('2026-07-31T17:00'), null).reason).toBe('user_was_recently_here');
  });

  it('does not pile a second unprompted message on the first', async () => {
    const life = await ready(() => localTime('2026-07-31T17:30'));
    const decision = life.shouldReachOut(localTime('2026-07-31T09:00'), localTime('2026-07-31T17:20'));
    expect(decision.reason).toBe('already_spoke');
  });

  it('honours the daily cap', async () => {
    const life = await ready(() => localTime('2026-07-31T17:30'), { maxReachOutsPerDay: 1 });
    const first = life.shouldReachOut(localTime('2026-07-31T09:00'), null);
    expect(first.reach).toBe(true);
    life.markShared(first.candidate!.id);

    const second = life.shouldReachOut(localTime('2026-07-31T09:00'), null);
    expect(second.reason).toBe('daily_cap');
  });

  it('says nothing when there is nothing she has not already mentioned', async () => {
    const life = await ready(() => localTime('2026-07-31T17:30'), { maxReachOutsPerDay: 99 });
    for (const row of harness!.app.repos.life.recent(10)) life.markShared(row.id);
    expect(life.shouldReachOut(localTime('2026-07-31T09:00'), null).reason).toBe('nothing_worth_saying');
  });

  it('never repeats the same activity once mentioned', async () => {
    const life = await ready(() => localTime('2026-07-31T17:30'), { maxReachOutsPerDay: 99 });
    const first = life.shouldReachOut(localTime('2026-07-31T09:00'), null);
    life.markShared(first.candidate!.id);
    const second = life.shouldReachOut(localTime('2026-07-31T09:00'), null);
    expect(second.candidate?.id).not.toBe(first.candidate!.id);
  });
});
