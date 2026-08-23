import type { FutureHarness } from '../harness.js';

/**
 * Deterministic-clock boundary cases (§43 PR4: deterministic clock 下的边界
 * 日期) and crash-retry idempotency (retry 后 Job 幂等), driven through the
 * service the job uses so absolute anchors stay reproducible.
 */
export async function boundaryDates(h: FutureHarness): Promise<void> {
  const repo = h.app.repos.commitments;
  const future = h.app.services.future;

  // Direct service calls consume the same scripted model queue as turns do.
  h.raw.setChatScript([
    [JSON.stringify({ commitments: [{ kind: 'user_event', subject: 'user', title: '面试', date_text: '明天', time_precision: 'day', confidence: 0.9 }] })],
    [JSON.stringify({ commitments: [{ kind: 'user_event', subject: 'user', title: '报告', date_text: '明天', time_precision: 'day', confidence: 0.9 }] })]
  ]);
  void h.app.repos;

  // "明天" written at 23:59 resolves to the next local day; so does the same
  // word written 90 seconds later across midnight.
  const lateNight = await future.analyzeAndApply({
    userText: '明天有个面试',
    assistantText: '',
    sourceMessageId: 'boundary-late',
    at: new Date('2026-08-19T15:59:00.000Z') // local 23:59 Aug 19
  });
  if (lateNight.extracted !== 1) throw new Error(`expected 1 extraction, got ${lateNight.extracted}`);
  const acrossMidnight = await future.analyzeAndApply({
    userText: '明天要交报告',
    assistantText: '',
    sourceMessageId: 'boundary-midnight',
    at: new Date('2026-08-19T16:01:00.000Z') // local 00:01 Aug 20
  });
  if (acrossMidnight.extracted !== 1) throw new Error(`expected 1 extraction, got ${acrossMidnight.extracted}`);
  const interview = repo.list().find((c) => c.title === '面试')!;
  const report = repo.list().find((c) => c.title === '报告')!;
  if (!interview.semanticKey.endsWith(':2026-08-20')) throw new Error(`interview key: ${interview.semanticKey}`);
  if (!report.semanticKey.endsWith(':2026-08-21')) throw new Error(`report key: ${report.semanticKey}`);
}

/** A crashed post-turn job retried must not double-write (§5.2). */
export async function retryIdempotency(h: FutureHarness): Promise<void> {
  const repo = h.app.repos.commitments;
  const future = h.app.services.future;
  h.raw.setChatScript([
    [JSON.stringify({ commitments: [{ kind: 'user_event', subject: 'user', title: '看牙医', date_text: '2026-08-26', time_precision: 'day', confidence: 0.9 }] })]
  ]);
  const first = await future.analyzeAndApply({
    userText: '2026-08-26 要看牙医',
    assistantText: '',
    sourceMessageId: 'retry-msg',
    at: new Date('2026-08-19T02:00:00.000Z')
  });
  if (first.extracted !== 1) throw new Error('first run should extract');
  const retry = await future.analyzeAndApply({
    userText: '2026-08-26 要看牙医',
    assistantText: '',
    sourceMessageId: 'retry-msg',
    at: new Date('2026-08-19T02:00:00.000Z')
  });
  if (!retry.skipped) throw new Error('retry must be fenced');
  if (repo.list().length !== 1) throw new Error(`expected 1 commitment, got ${repo.list().length}`);
}
