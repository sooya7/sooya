import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/index.js';
import { CommitmentRepo } from '../src/db/repos/commitment.repo.js';
import { PostTurnSemanticAnalyzer } from '../src/core/post-turn/analyzer.js';
import { FutureService } from '../src/core/future/service.js';
import { parseDayOffset, parseMinuteOfDay, resolveCommitmentTime, zonedParts, zonedToUtc } from '../src/core/future/time-parser.js';
import { parseAnalyzerOutput } from '../src/core/post-turn/schema.js';
import type { ChatProvider } from '../src/providers/types.js';

const TZ = 'Asia/Shanghai';
/** Saturday, 2026-08-22 15:30 local (07:30 UTC). */
const NOW = new Date('2026-08-22T07:30:00.000Z');

describe('deterministic time parsing (§6)', () => {
  it('resolves relative day words', () => {
    expect(parseDayOffset('今天', NOW, TZ)).toBe(0);
    expect(parseDayOffset('明天', NOW, TZ)).toBe(1);
    expect(parseDayOffset('后天', NOW, TZ)).toBe(2);
    expect(parseDayOffset('大后天', NOW, TZ)).toBe(3);
    expect(parseDayOffset('3天后', NOW, TZ)).toBe(3);
  });

  it('resolves weekdays forward, never backwards', () => {
    // Today is Saturday: Monday is +2, Friday +6, and "周六" on a Saturday means next week's.
    expect(parseDayOffset('周一', NOW, TZ)).toBe(2);
    expect(parseDayOffset('星期五', NOW, TZ)).toBe(6);
    expect(parseDayOffset('周六', NOW, TZ)).toBe(7);
    // Next week starts Monday (+2); its Wednesday is +4.
    expect(parseDayOffset('下周三', NOW, TZ)).toBe(4);
    expect(parseDayOffset('周日', NOW, TZ)).toBe(1);
  });

  it('resolves calendar dates and rolls to next year when past', () => {
    expect(parseDayOffset('8月28日', NOW, TZ)).toBe(6);
    expect(parseDayOffset('8-22', NOW, TZ)).toBe(0);
    expect(parseDayOffset('2026-08-20', NOW, TZ)).toBe(-2);
    // Said in August, a June date belongs to next year.
    expect(parseDayOffset('6月1号', NOW, TZ)).toBe(283);
    expect(parseDayOffset('1月2日', NOW, TZ)).toBe(133);
  });

  it('returns null for unparseable or empty text', () => {
    expect(parseDayOffset(' sometime ', NOW, TZ)).toBeNull();
    expect(parseDayOffset('', NOW, TZ)).toBeNull();
    expect(parseDayOffset('下个月', NOW, TZ)).toBeNull();
  });

  it('parses clock times with meridiem prefixes and Chinese numerals', () => {
    expect(parseMinuteOfDay('20:30')).toBe(20 * 60 + 30);
    expect(parseMinuteOfDay('晚上八点')).toBe(20 * 60);
    expect(parseMinuteOfDay('晚上八点半')).toBe(20 * 60 + 30);
    expect(parseMinuteOfDay('下午3点一刻')).toBe(15 * 60 + 15);
    expect(parseMinuteOfDay('凌晨两点')).toBe(2 * 60);
    expect(parseMinuteOfDay('中午十二点')).toBe(12 * 60);
    expect(parseMinuteOfDay('早上九点40分')).toBe(9 * 60 + 40);
    expect(parseMinuteOfDay('9:05')).toBe(9 * 60 + 5);
  });

  it('combines date and time into exact zoned instants', () => {
    const resolved = resolveCommitmentTime({ dateText: '明天', timeText: '晚上八点半', now: NOW, timeZone: TZ })!;
    expect(resolved.startsAt).toBe('2026-08-23T12:30:00.000Z');
    expect(resolved.dueAt).toBe(resolved.startsAt);
  });

  it('day precision spans the whole local day', () => {
    const resolved = resolveCommitmentTime({ dateText: '周五', now: NOW, timeZone: TZ })!;
    expect(resolved.startsAt).toBe('2026-08-27T16:00:00.000Z'); // local midnight Aug 28
    expect(resolved.dueAt).toBe('2026-08-28T15:59:00.000Z'); // local 23:59 Aug 28
    expect(resolved.latestReachOutAt).toBe(resolved.dueAt);
  });

  it('a time without a date belongs to the next matching day', () => {
    // Saturday 21:00 local: "晚上八点" already passed → tomorrow 20:00 local.
    const atNight = resolveCommitmentTime({ timeText: '晚上八点', now: new Date('2026-08-22T13:00:00.000Z'), timeZone: TZ })!;
    expect(atNight.startsAt).toBe('2026-08-23T12:00:00.000Z');
    // Saturday 10:00 local: tonight.
    const atDay = resolveCommitmentTime({ timeText: '晚上八点', now: new Date('2026-08-22T02:00:00.000Z'), timeZone: TZ })!;
    expect(atDay.startsAt).toBe('2026-08-22T12:00:00.000Z');
  });

  it('returns null when nothing resolves, instead of guessing', () => {
    expect(resolveCommitmentTime({ dateText: '下个月', timeText: null, now: NOW, timeZone: TZ })).toBeNull();
    expect(resolveCommitmentTime({ dateText: null, timeText: null, now: NOW, timeZone: TZ })).toBeNull();
  });

  it('zoned helpers round-trip across a UTC-offset boundary', () => {
    expect(zonedParts(new Date('2026-08-22T16:00:00.000Z'), TZ)).toEqual({
      year: 2026, month: 8, day: 23, weekday: 7, hour: 0, minute: 0
    });
    expect(zonedToUtc(2026, 8, 23, 0, 0, TZ).toISOString()).toBe('2026-08-22T16:00:00.000Z');
  });
});

describe('analyzer output schema (§7)', () => {
  it('accepts a complete payload and defaults the rest', () => {
    const parsed = parseAnalyzerOutput(
      JSON.stringify({
        commitments: [{ kind: 'user_event', title: '考试', date_text: '周五', time_precision: 'day', confidence: 0.9 }],
        commitment_resolutions: [{ commitment_id: 'cmt_1', action: 'completed', outcome: '考完了' }]
      })
    )!;
    expect(parsed.commitments).toHaveLength(1);
    expect(parsed.commitments[0]!.subject).toBe('user');
    expect(parsed.commitments[0]!.follow_up).toBe('natural');
    expect(parsed.commitment_resolutions[0]!.action).toBe('completed');
    expect(parsed.relationship_signals).toEqual([]);
  });

  it('tolerates prose-wrapped JSON and rejects garbage', () => {
    const wrapped = parseAnalyzerOutput('好的，结果是 {"commitments":[],"commitment_resolutions":[]} 以上。');
    expect(wrapped).not.toBeNull();
    expect(parseAnalyzerOutput('完全不是 JSON')).toBeNull();
    expect(parseAnalyzerOutput(JSON.stringify({ commitments: [{ kind: 'nonsense', title: 'x' }] }))).toBeNull();
  });
});

/**
 * Scripted ChatProvider. Each queued entry is either a raw response body or a
 * function of the system prompt — the prompt carries the active commitment ids,
 * which resolution scripts need to echo back.
 */
function scriptedProvider(responses: Array<string | ((system: string) => string)>): { provider: ChatProvider; prompts: string[] } {
  const prompts: string[] = [];
  const provider = {
    configured: true,
    async complete(req: { system?: string }) {
      prompts.push(String(req.system ?? ''));
      const next = responses.shift();
      if (next === undefined) throw new Error('script exhausted');
      const text = typeof next === 'function' ? next(prompts.at(-1)!) : next;
      return { text, model: 'mock', usage: null } as never;
    }
  } as unknown as ChatProvider;
  return { provider, prompts };
}

/** First `id=...` referenced in the analyzer prompt's active list. */
function firstActiveId(prompt: string): string {
  return /id=([^\s]+)\s*\[/.exec(prompt)?.[1] ?? '';
}

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

function futureWith(
  responses: Array<string | ((system: string) => string)>,
  clock: () => Date = () => NOW
): { service: FutureService; repo: CommitmentRepo } {
  const db = new Database(':memory:');
  open.push(db);
  migrate(db);
  const repo = new CommitmentRepo(db);
  const { provider } = scriptedProvider(responses);
  const service = new FutureService({
    repo,
    analyzer: new PostTurnSemanticAnalyzer({ provider, relationshipEnabled: false }),
    timeZone: TZ,
    clock
  });
  return { service, repo };
}

describe('FutureService.analyzeAndApply', () => {
  it('extracts a dated commitment from a scripted analyzer response', async () => {
    const { service, repo } = futureWith([
      JSON.stringify({
        commitments: [{ kind: 'user_event', subject: 'user', title: '考试', date_text: '周五', time_precision: 'day', confidence: 0.94 }]
      })
    ]);
    const outcome = await service.analyzeAndApply({ userText: '我周五要考试', assistantText: '加油', sourceMessageId: 'msg_1' });
    expect(outcome).toEqual({ skipped: false, extracted: 1, merged: 0, resolved: 0, rescheduled: 0 });
    const c = repo.list()[0]!;
    expect(c.status).toBe('pending');
    expect(c.semanticKey).toBe('user_event:user:考试:2026-08-28');
    expect(c.sourceMessageId).toBe('msg_1');
  });

  it('never analyzes the same message twice (job idempotency fence, §5.2)', async () => {
    const { service, repo } = futureWith([
      JSON.stringify({ commitments: [{ kind: 'user_event', title: '考试', date_text: '周五', confidence: 0.9 }] })
    ]);
    await service.analyzeAndApply({ userText: '周五考试', assistantText: '', sourceMessageId: 'msg_1' });
    const second = await service.analyzeAndApply({ userText: '周五考试', assistantText: '', sourceMessageId: 'msg_1' });
    expect(second.skipped).toBe(true);
    expect(repo.list()).toHaveLength(1);
  });

  it('merges a repeated mention instead of duplicating', async () => {
    const { service, repo } = futureWith([
      JSON.stringify({ commitments: [{ kind: 'user_event', title: '考试', date_text: '周五', confidence: 0.9 }] }),
      JSON.stringify({ commitments: [{ kind: 'user_event', title: '考试', date_text: '周五', confidence: 0.95 }] })
    ]);
    await service.analyzeAndApply({ userText: '周五考试', assistantText: '', sourceMessageId: 'msg_1' });
    const outcome = await service.analyzeAndApply({ userText: '对，周五考试', assistantText: '', sourceMessageId: 'msg_2' });
    expect(outcome.merged).toBe(1);
    expect(repo.list()).toHaveLength(1);
  });

  it('applies completion and reschedule resolutions with supersede semantics', async () => {
    const { service, repo } = futureWith([
      JSON.stringify({ commitments: [{ kind: 'follow_up', subject: 'user', title: 'pr 检查', date_text: null, time_precision: 'unknown', confidence: 0.8 }] }),
      (prompt) =>
        JSON.stringify({
          commitments: [],
          commitment_resolutions: [{ commitment_id: firstActiveId(prompt), action: 'rescheduled', date_text: '下周五', confidence: 0.9 }]
        }),
      (prompt) =>
        JSON.stringify({
          commitments: [],
          commitment_resolutions: [{ commitment_id: firstActiveId(prompt), action: 'completed', outcome: '已经合了' }]
        })
    ]);
    const first = await service.analyzeAndApply({ userText: '等 PR 合了再看看', assistantText: '', sourceMessageId: 'msg_1' });
    expect(first.extracted).toBe(1);
    const prId = repo.list()[0]!.id;

    const second = await service.analyzeAndApply({ userText: '改到下周五再看', assistantText: '', sourceMessageId: 'msg_2' });
    expect(second.rescheduled).toBe(1);
    const chain = repo.supersedeChain(prId);
    expect(chain).toHaveLength(2);
    expect(chain[0]!.status).toBe('superseded');
    expect(chain[1]!.status).toBe('pending');
    expect(chain[1]!.semanticKey).toBe('follow_up:user:pr 检查:2026-08-28');

    const third = await service.analyzeAndApply({ userText: '已经合了', assistantText: '', sourceMessageId: 'msg_3' });
    expect(third.resolved).toBe(1);
    expect(repo.get(chain[1]!.id)!.status).toBe('completed');
  });

  it('marks low-confidence fuzzy items tentative and keeps reminders explicit', async () => {
    const { service, repo } = futureWith([
      JSON.stringify({
        commitments: [
          { kind: 'user_event', title: '去大阪', date_text: '下个月', time_precision: 'relative', confidence: 0.4 },
          { kind: 'reminder_request', title: '续费提醒', date_text: '明天', time_text: '上午九点', time_precision: 'exact', confidence: 0.95, follow_up: 'explicit_reminder' }
        ]
      })
    ]);
    await service.analyzeAndApply({ userText: '下个月可能去大阪；明天上午九点提醒我续费', assistantText: '', sourceMessageId: 'msg_1' });
    const trip = repo.list().find((c) => c.title === '去大阪')!;
    const reminder = repo.list().find((c) => c.title === '续费提醒')!;
    expect(trip.status).toBe('tentative');
    expect(trip.timePrecision).toBe('unknown'); // "下个月" does not resolve on day scale
    expect(reminder.followUpPolicy).toBe('explicit_reminder');
    expect(reminder.latestReachOutAt).toBeTruthy();
  });

  it('ignores resolutions that reference unknown commitments', async () => {
    const { service, repo } = futureWith([
      JSON.stringify({ commitments: [{ kind: 'user_event', title: '考试', date_text: '周五', confidence: 0.9 }] }),
      JSON.stringify({
        commitments: [],
        commitment_resolutions: [{ commitment_id: 'cmt_not_in_list', action: 'completed', confidence: 0.9 }]
      })
    ]);
    await service.analyzeAndApply({ userText: '周五考试', assistantText: '', sourceMessageId: 'msg_1' });
    const outcome = await service.analyzeAndApply({ userText: '弄好了', assistantText: '', sourceMessageId: 'msg_2' });
    expect(outcome.resolved).toBe(0);
    expect(repo.list()[0]!.status).toBe('pending');
  });

  it('degrades to empty output when the model misbehaves', async () => {
    const { service, repo } = futureWith(['完全不是 JSON']);
    const outcome = await service.analyzeAndApply({ userText: '周五考试', assistantText: '', sourceMessageId: 'msg_1' });
    expect(outcome.extracted).toBe(0);
    expect(repo.list()).toHaveLength(0);
  });
});
