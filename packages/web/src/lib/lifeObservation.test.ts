import { describe, expect, it } from 'vitest';
import type { LifeEventRow, LifeLogRow, LifePlanRow, LifeSettings, ProactiveAttempt } from './features.js';
import {
  contactBoundaryPayload,
  lifeKindLabel,
  lifePlanStatusText,
  mergeLifeHistory,
  previewPlans
} from './lifeObservation.js';

function plan(overrides: Partial<LifePlanRow> & Pick<LifePlanRow, 'id' | 'status'>): LifePlanRow {
  return {
    title: overrides.id,
    kind: 'task',
    planned_start: null,
    planned_end: null,
    source: 'test',
    priority: 0,
    created_at: '2026-08-09T08:00:00.000Z',
    updated_at: '2026-08-09T08:00:00.000Z',
    ...overrides
  };
}

describe('life observation labels', () => {
  it('renders every known life kind as a Chinese label', () => {
    expect(Object.fromEntries([
      'chore', 'out', 'play', 'meal', 'rest', 'sleep',
      'study', 'work', 'wake', 'wind_down', 'reading', 'task'
    ].map((kind) => [kind, lifeKindLabel(kind)]))).toEqual({
      chore: '家务',
      out: '出门',
      play: '玩耍',
      meal: '吃饭',
      rest: '休息',
      sleep: '睡觉',
      study: '学习',
      work: '工作',
      wake: '起床',
      wind_down: '睡前放松',
      reading: '阅读',
      task: '任务'
    });
  });

  it('renders every known plan status as observation language', () => {
    expect(Object.fromEntries([
      'planned', 'active', 'paused', 'completed', 'cancelled', 'skipped'
    ].map((status) => [status, lifePlanStatusText(status)]))).toEqual({
      planned: '可能',
      active: '正在进行',
      paused: '暂时搁置',
      completed: '已经完成',
      cancelled: '已经放下',
      skipped: '没有去做'
    });
  });

  it('keeps unknown kind and status values visible', () => {
    expect(lifeKindLabel('future_kind')).toBe('future_kind');
    expect(lifePlanStatusText('future_status')).toBe('future_status');
  });
});

describe('previewPlans', () => {
  it('prioritizes active plans, excludes terminal states, limits to three, and leaves input untouched', () => {
    const plans = [
      plan({ id: 'planned-later', status: 'planned', priority: 4, planned_start: '2026-08-10T10:00:00.000Z' }),
      plan({ id: 'completed', status: 'completed', priority: 99 }),
      plan({ id: 'active', status: 'active', priority: 0 }),
      plan({ id: 'paused', status: 'paused', priority: 5, created_at: '2026-08-09T09:00:00.000Z' }),
      plan({ id: 'planned-earlier', status: 'planned', priority: 4, planned_start: '2026-08-10T08:00:00.000Z' }),
      plan({ id: 'cancelled', status: 'cancelled', priority: 100 })
    ];
    const before = structuredClone(plans);

    expect(previewPlans(plans).map(({ id }) => id)).toEqual([
      'active',
      'paused',
      'planned-earlier'
    ]);
    expect(plans).toEqual(before);
  });

  it('falls back to created_at when planned_start is empty', () => {
    const plans = [
      plan({ id: 'later', status: 'planned', priority: 1, planned_start: '', created_at: '2026-08-09T10:00:00.000Z' }),
      plan({ id: 'earlier', status: 'planned', priority: 1, planned_start: '', created_at: '2026-08-09T08:00:00.000Z' })
    ];

    expect(previewPlans(plans).map(({ id }) => id)).toEqual(['earlier', 'later']);
  });

  it('places plans without any valid time after valid plans so they cannot displace the preview', () => {
    const plans = [
      plan({ id: 'invalid', status: 'planned', priority: 99, planned_start: 'not-a-date', created_at: '' }),
      plan({ id: 'valid-3', status: 'planned', priority: 1, planned_start: '2026-08-09T10:00:00.000Z' }),
      plan({ id: 'valid-1', status: 'planned', priority: 1, planned_start: '2026-08-09T08:00:00.000Z' }),
      plan({ id: 'valid-2', status: 'planned', priority: 1, planned_start: '2026-08-09T09:00:00.000Z' })
    ];

    expect(previewPlans(plans).map(({ id }) => id)).toEqual(['valid-1', 'valid-2', 'valid-3']);
  });

  it('preserves source order when plan sorting keys are equal', () => {
    const plans = [
      plan({ id: 'first', status: 'planned', priority: 1, planned_start: '2026-08-09T08:00:00.000Z' }),
      plan({ id: 'second', status: 'planned', priority: 1, planned_start: '2026-08-09T08:00:00.000Z' })
    ];

    expect(previewPlans(plans).map(({ id }) => id)).toEqual(['first', 'second']);
  });
});

describe('mergeLifeHistory', () => {
  it('merges activity, event, and proactive records from newest to oldest', () => {
    const log: LifeLogRow[] = [{
      id: 'activity-1', activity: '整理房间', kind: 'chore', mood: '轻松',
      started_at: '2026-08-09T08:00:00.000Z', ended_at: '2026-08-09T09:00:00.000Z', shared: 1
    }];
    const events: LifeEventRow[] = [{
      id: 'event-1', plan_id: null, log_id: 'activity-1', event_type: 'finished', activity: '散步', kind: 'out',
      description: '出门散步', mood_before: null, mood_after: null, happened_at: '2026-08-09T10:00:00.000Z',
      shareable: 1, shared_at: null, created_at: '2026-08-09T10:00:00.000Z'
    }];
    const proactive: ProactiveAttempt[] = [{
      id: 'proactive-1', candidateId: null, candidateKind: null, candidateActivity: null, status: 'blocked',
      blockedReason: 'quiet_hours', requestedMode: null, finalMode: null, fallbackReason: null, messageId: null,
      sendSuccess: false, userResponseMessageId: null, userRespondedAt: null, detail: {},
      createdAt: '2026-08-09T11:00:00.000Z', updatedAt: '2026-08-09T11:00:00.000Z'
    }];

    expect(mergeLifeHistory(log, events, proactive)).toEqual([
      {
        kind: 'proactive', id: 'proactive-1', at: '2026-08-09T11:00:00.000Z',
        title: '动态发布尝试', detail: '暂未发布'
      },
      {
        kind: 'event', id: 'event-1', at: '2026-08-09T10:00:00.000Z',
        title: '出门散步', detail: '出门'
      },
      {
        kind: 'activity', id: 'activity-1', at: '2026-08-09T09:00:00.000Z',
        title: '整理房间', detail: '已经分享'
      }
    ]);
  });

  it('uses mood for unshared activity and maps proactive sent or failed outcomes', () => {
    const log: LifeLogRow[] = [{
      id: 'activity-2', activity: '读书', kind: 'reading', mood: '专注',
      started_at: '2026-08-09T07:00:00.000Z', ended_at: '2026-08-09T08:00:00.000Z', shared: 0
    }];
    const proactive = (id: string, status: ProactiveAttempt['status'], at: string): ProactiveAttempt => ({
      id, candidateId: null, candidateKind: null, candidateActivity: '分享读书心得', status,
      blockedReason: null, requestedMode: 'text', finalMode: status === 'sent' ? 'text' : null,
      fallbackReason: null, messageId: null, sendSuccess: status === 'sent', userResponseMessageId: null,
      userRespondedAt: null, detail: {}, createdAt: at, updatedAt: at
    });

    expect(mergeLifeHistory(log, [], [
      proactive('sent', 'sent', '2026-08-09T10:00:00.000Z'),
      proactive('failed', 'failed', '2026-08-09T09:00:00.000Z')
    ]).map(({ title, detail }) => ({ title, detail }))).toEqual([
      { title: '分享读书心得', detail: '已发布动态' },
      { title: '分享读书心得', detail: '发布失败' },
      { title: '读书', detail: '专注' }
    ]);
  });

  it('places invalid history times after valid times and preserves source order for equal keys', () => {
    const activity = (id: string, endedAt: string): LifeLogRow => ({
      id,
      activity: id,
      kind: 'task',
      mood: '平静',
      started_at: '2026-08-09T07:00:00.000Z',
      ended_at: endedAt,
      shared: 0
    });

    expect(mergeLifeHistory([
      activity('invalid-first', 'not-a-date'),
      activity('equal-first', '2026-08-09T10:00:00.000Z'),
      activity('equal-second', '2026-08-09T10:00:00.000Z'),
      activity('older', '2026-08-09T09:00:00.000Z'),
      activity('invalid-second', '')
    ], [], []).map(({ id }) => id)).toEqual([
      'equal-first',
      'equal-second',
      'older',
      'invalid-first',
      'invalid-second'
    ]);
  });
});

describe('contactBoundaryPayload', () => {
  it('returns only contact-boundary settings and defaults proactive mode to auto', () => {
    const settings: LifeSettings = {
      reachOut: true,
      quietGapMinutes: 90,
      maxReachOutsPerDay: 3,
      silentFrom: 23,
      silentTo: 7,
      tzOffsetMinutes: 480
    };

    expect(contactBoundaryPayload(settings)).toEqual({
      reachOut: true,
      quietGapMinutes: 90,
      maxReachOutsPerDay: 3,
      silentFrom: 23,
      silentTo: 7,
      proactiveMode: 'auto'
    });
    expect(contactBoundaryPayload(settings)).not.toHaveProperty('tzOffsetMinutes');
  });
});
