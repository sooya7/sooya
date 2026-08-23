import { expect } from 'vitest';
import type { FutureHarness } from '../harness.js';
import { expectContextMentions, expectSingleCommitment, expectStatus } from '../assertions.js';

/**
 * Scenario B core (§28 Commitment): extract → natural care context → user
 * reports completion → no more prompts. Also covers duplicate mentions,
 * rescheduling, and the time-driven missed/expired/archive lifecycle.
 */
export async function commitmentLifecycle(h: FutureHarness): Promise<void> {
  const repo = h.app.repos.commitments;

  // Day 1 (Wed 2026-08-19): the user mentions an exam on the coming Friday.
  await h.turn('我周五要考试，有点紧张', {
    analyzer: JSON.stringify({
      commitments: [{ kind: 'user_event', subject: 'user', title: '考试', date_text: '2026-08-21', time_precision: 'day', confidence: 0.94 }]
    })
  });
  let exam = expectSingleCommitment(repo.list());
  expectStatus(exam, 'pending');
  expect(exam.semanticKey).toBe('user_event:user:考试:2026-08-21');

  // Duplicate mention on day 2 must reinforce, not duplicate (§5.1).
  await h.turn('对，就是周五那个考试', {
    analyzer: JSON.stringify({
      commitments: [{ kind: 'user_event', subject: 'user', title: '考试', date_text: '2026-08-21', time_precision: 'day', confidence: 0.9 }]
    })
  });
  exam = expectSingleCommitment(repo.list());

  // Reschedule to the next Friday: supersede + new row, full chain (§12).
  await h.turn('考试改到 2026-08-28 了', {
    analyzer: JSON.stringify({
      commitments: [],
      commitment_resolutions: [{ commitment_id: exam.id, action: 'rescheduled', date_text: '2026-08-28', confidence: 0.92 }]
    })
  });
  const chain = repo.supersedeChain(exam.id);
  if (chain.length !== 2) throw new Error(`expected supersede chain of 2, got ${chain.length}`);
  expectStatus(chain[0], 'superseded');
  expectStatus(chain[1], 'pending');
  expect(chain[1]!.semanticKey).toBe('user_event:user:考试:2026-08-28');

  // Day of the exam: the item is due and still in context.
  h.advanceAndTick('2026-08-28T04:00:00.000Z'); // local 12:00 Friday
  expectStatus(repo.get(chain[1]!.id), 'due');
  expectContextMentions(h.app, '考试', 1);

  // Same day evening: the user reports completion; context stops mentioning it (§11).
  await h.turn('考完了，感觉还行', {
    analyzer: JSON.stringify({
      commitments: [],
      commitment_resolutions: [{ commitment_id: chain[1]!.id, action: 'completed', outcome: '考完了', confidence: 0.95 }]
    })
  });
  expectStatus(repo.get(chain[1]!.id), 'completed');
  expectContextMentions(h.app, '考试', 0);

  // Stale-leak check (§29 stale injection): a week later nothing resurfaces.
  h.advanceAndTick('2026-09-04T04:00:00.000Z');
  expectContextMentions(h.app, '考试', 0);
}

/** §13 time-driven transitions with no user present at all. */
export async function unattendedLifecycle(h: FutureHarness): Promise<void> {
  const repo = h.app.repos.commitments;

  // An explicit reminder the user asked for, plus a fuzzy trip idea.
  await h.turn('2026-08-20 上午九点提醒我续费服务器', {
    analyzer: JSON.stringify({
      commitments: [
        { kind: 'reminder_request', subject: 'user', title: '续费提醒', date_text: '2026-08-20', time_text: '上午九点', time_precision: 'exact', confidence: 0.95, follow_up: 'explicit_reminder' },
        { kind: 'user_event', subject: 'user', title: '去大阪', date_text: '2026-08-21', time_precision: 'range', confidence: 0.4 }
      ]
    })
  });
  const reminder = repo.list().find((c) => c.title === '续费提醒')!;
  const trip = repo.list().find((c) => c.title === '去大阪')!;
  expectStatus(trip, 'tentative');

  // Nobody talks for ten days. The reminder missed its window; the tentative
  // trip expired (range precision keeps a 7-day grace); nothing is silently
  // archived as if it never existed.
  h.advanceAndTick('2026-08-29T04:00:00.000Z');
  expectStatus(repo.get(reminder.id), 'missed');
  expectStatus(repo.get(trip.id), 'expired');
  expectContextMentions(h.app, '续费', 0);
  expectContextMentions(h.app, '大阪', 0);

  // An ordinary user event past its grace window is archived, not missed.
  await h.turn('2026-08-10 有个体检', {
    analyzer: JSON.stringify({
      commitments: [{ kind: 'user_event', subject: 'user', title: '体检', date_text: '2026-08-10', time_precision: 'day', confidence: 0.85 }]
    })
  });
  const checkup = repo.list().find((c) => c.title === '体检')!;
  h.advanceAndTick('2026-08-29T04:00:00.000Z');
  const archivedRow = repo.get(checkup.id)!;
  expectStatus(archivedRow, 'due');
  if (!archivedRow.archivedAt) throw new Error('expected archivedAt set after grace window');
  expectContextMentions(h.app, '体检', 0);
}
