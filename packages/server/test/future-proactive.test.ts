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

/**
 * PR5 — Future candidates join the unified arbiter: semantic candidate in,
 * model-worded care message out, exactly one attempt per commitment, hard
 * gates still unbeatable.
 */
describe('Future proactive candidates', () => {
  it('sends a model-worded care message for an imminent commitment', async () => {
    harness = await createHarness({
      env: {
        FUTURE_ENGINE_ENABLED: 'true',
        FUTURE_PROACTIVE_ENABLED: 'true',
        ENABLE_LIFE_ENGINE: 'true',
        ENABLE_LIFE_REACH_OUT: 'true',
        LIFE_QUIET_GAP_MINUTES: '60'
      },
      clock: () => localTime('2026-08-21T09:30'),
      chat: { script: [['面试加油，别紧张，中午想吃点什么就吃点什么。']] }
    });
    const now = localTime('2026-08-21T09:30');
    // An interview 90 minutes out, exact precision.
    harness.app.repos.commitments.ingest({
      kind: 'user_event',
      subject: 'user',
      title: '面试',
      startsAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
      dueAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
      timePrecision: 'exact',
      confidence: 0.95,
      importance: 0.8,
      followUpPolicy: 'natural',
      sourceMessageId: 'seed',
      timeZone: harness.app.env.LIFE_TIME_ZONE
    });

    const evaluation = harness.app.services.proactive.evaluate();
    expect(evaluation.reach).toBe(true);
    expect(evaluation.selected?.source).toBe('commitment');
    expect(evaluation.selected?.commitment?.title).toBe('面试');

    const result = await harness.app.services.proactive.run();
    expect(result.status).toBe('sent');
    expect(result.candidateId).toMatch(/^commitment:/);
    const [attempt] = harness.app.repos.proactive.list(5);
    expect(attempt.status).toBe('sent');
    expect(attempt.candidateId).toMatch(/^commitment:/);
    expect(attempt.detail.destination).toBe('qq');
  });

  it('never repeats the same commitment in a later cycle', async () => {
    harness = await createHarness({
      env: {
        FUTURE_ENGINE_ENABLED: 'true',
        FUTURE_PROACTIVE_ENABLED: 'true',
        ENABLE_LIFE_ENGINE: 'true',
        ENABLE_LIFE_REACH_OUT: 'true',
        LIFE_QUIET_GAP_MINUTES: '1'
      },
      clock: () => localTime('2026-08-21T09:30'),
      chat: { script: [['面试加油！'], ['不该到这里']] }
    });
    const now = localTime('2026-08-21T09:30');
    harness.app.repos.commitments.ingest({
      kind: 'user_event',
      subject: 'user',
      title: '面试',
      startsAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
      dueAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
      timePrecision: 'exact',
      confidence: 0.95,
      importance: 0.8,
      followUpPolicy: 'natural',
      sourceMessageId: 'seed',
      timeZone: harness.app.env.LIFE_TIME_ZONE
    });
    const first = await harness.app.services.proactive.run();
    expect(first.status).toBe('sent');
    const second = await harness.app.services.proactive.run();
    expect(second.status).toBe('blocked');
    expect(second.blockedReason).toBe('already_sent');
  });

  it('stays dark when the future-proactive flag is off', async () => {
    harness = await createHarness({
      env: { FUTURE_ENGINE_ENABLED: 'true', FUTURE_PROACTIVE_ENABLED: 'false', ENABLE_LIFE_ENGINE: 'true' },
      clock: () => localTime('2026-08-21T09:30')
    });
    const now = localTime('2026-08-21T09:30');
    harness.app.repos.commitments.ingest({
      kind: 'user_event',
      subject: 'user',
      title: '面试',
      startsAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
      dueAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
      timePrecision: 'exact',
      confidence: 0.95,
      followUpPolicy: 'natural',
      sourceMessageId: 'seed',
      timeZone: harness.app.env.LIFE_TIME_ZONE
    });
    const evaluation = harness.app.services.proactive.evaluate();
    expect(evaluation.reach).toBe(false);
    expect(evaluation.reason).not.toBe('ok');
  });

  it('cannot beat Life hard gates (silent hours)', async () => {
    harness = await createHarness({
      env: {
        FUTURE_ENGINE_ENABLED: 'true',
        FUTURE_PROACTIVE_ENABLED: 'true',
        ENABLE_LIFE_ENGINE: 'true',
        ENABLE_LIFE_REACH_OUT: 'true'
      },
      clock: () => localTime('2026-08-21T02:30'), // deep night, silent hours
      chat: { script: [['不该到这里']] }
    });
    const now = localTime('2026-08-21T02:30');
    harness.app.repos.commitments.ingest({
      kind: 'user_event',
      subject: 'user',
      title: '面试',
      startsAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
      dueAt: new Date(now.getTime() + 90 * 60_000).toISOString(),
      timePrecision: 'exact',
      confidence: 0.95,
      importance: 0.8,
      followUpPolicy: 'natural',
      sourceMessageId: 'seed',
      timeZone: harness.app.env.LIFE_TIME_ZONE
    });
    const evaluation = harness.app.services.proactive.evaluate();
    expect(evaluation.reach).toBe(false);
    expect(['silent_hours', 'asleep']).toContain(evaluation.reason);
  });
});
