import { describe, expect, it } from 'vitest';
import type { LifePanelData } from './features.js';
import { formatGap, herClock, proactiveReasonText, reachReasonText, slotProgress, sortedLog } from './lifeView.js';

const settings: LifePanelData['settings'] = {
  reachOut: true,
  quietGapMinutes: 180,
  maxReachOutsPerDay: 3,
  silentFrom: 0,
  silentTo: 9,
  tzOffsetMinutes: 480
};

const reachOut = (patch: Partial<LifePanelData['reachOut']>): LifePanelData['reachOut'] => ({
  reach: false,
  reason: 'nothing_worth_saying',
  candidate: null,
  sharedLastDay: 0,
  lastUserAt: null,
  lastAssistantAt: null,
  enabledByDeployment: true,
  ...patch
});

describe('lifeView', () => {
  it('explains each silence reason in a way you can act on', () => {
    expect(reachReasonText({ settings, reachOut: reachOut({ reason: 'nothing_worth_saying' }) }))
      .toContain('还没有值得发布的新动态');
    expect(reachReasonText({ settings, reachOut: reachOut({ reason: 'silent_hours' }) }))
      .toContain('00:00 – 09:00');
    expect(reachReasonText({ settings, reachOut: reachOut({ reason: 'daily_cap', sharedLastDay: 3 }) }))
      .toContain('3/3');
    expect(reachReasonText({ settings, reachOut: reachOut({ reach: true, reason: 'share_candidate' }) }))
      .toBe('有值得分享的新动态');
  });

  it('quotes the configured gap and how long ago you spoke', () => {
    const text = reachReasonText({
      settings,
      reachOut: reachOut({ reason: 'user_was_recently_here', lastUserAt: new Date(Date.now() - 45 * 60_000).toISOString() })
    });
    expect(text).toContain('180 分钟');
    expect(text).toContain('45 分钟');
  });

  /** 部署层的 kill switch 面板改不动，所以必须优先说，否则用户会去调没用的开关。 */
  it('reports the deployment kill switch ahead of any other reason', () => {
    const text = reachReasonText({ settings, reachOut: reachOut({ reason: 'nothing_worth_saying', enabledByDeployment: false }) });
    expect(text).toContain('ENABLE_LIFE_REACH_OUT');
  });

  it('falls back to the raw reason instead of showing nothing', () => {
    expect(reachReasonText({ settings, reachOut: reachOut({ reason: 'brand_new_reason' }) })).toBe('brand_new_reason');
  });

  it('translates every proactive result produced by the current server', () => {
    expect(proactiveReasonText('share_candidate')).toBe('有值得分享的新动态');
    expect(proactiveReasonText('compose_failed')).toBe('动态文案生成失败');
    expect(proactiveReasonText('empty_text')).toBe('模型没有生成可发布文字');
    expect(proactiveReasonText('media_failed')).toBe('动态图片准备失败');
    expect(proactiveReasonText('moment_persist_failed: database busy')).toBe('动态保存失败');
  });

  it('formats gaps in the largest useful unit', () => {
    expect(formatGap(30_000)).toBe('不到 1 分钟');
    expect(formatGap(45 * 60_000)).toBe('45 分钟');
    expect(formatGap(5 * 3_600_000)).toBe('5 小时');
    expect(formatGap(50 * 3_600_000)).toBe('2 天');
    expect(formatGap(-1000)).toBe('不到 1 分钟');
  });

  it('shows the clock in her timezone, not the browser one', () => {
    // 16:00Z 是她那边的 00:00，界面上必须写 00:00，否则跟她说的话对不上
    expect(herClock('2026-07-30T16:00:00.000Z', 480)).toBe('00:00');
    expect(herClock(null, 480)).toBe('—');
    expect(herClock('不是时间', 480)).toBe('—');
  });

  it('measures how far into the activity she is', () => {
    const snapshot = { startedAt: '2026-07-31T00:00:00.000Z', endsAt: '2026-07-31T08:00:00.000Z' };
    const at = Date.parse('2026-07-31T02:00:00.000Z');
    expect(slotProgress(snapshot, at)).toEqual({ percent: 25, intoIt: '2 小时', left: '6 小时' });
  });

  it('clamps the progress bar instead of drawing past the edge', () => {
    const snapshot = { startedAt: '2026-07-31T00:00:00.000Z', endsAt: '2026-07-31T08:00:00.000Z' };
    expect(slotProgress(snapshot, Date.parse('2026-07-31T20:00:00.000Z')).percent).toBe(100);
    expect(slotProgress(snapshot, Date.parse('2026-07-30T20:00:00.000Z')).percent).toBe(0);
    expect(slotProgress({ startedAt: 'x', endsAt: 'y' }).percent).toBe(0);
  });

  it('puts the newest activity on top of the log', () => {
    const rows = sortedLog([
      { started_at: '2026-07-31T01:00:00.000Z', activity: '早' },
      { started_at: '2026-07-31T09:00:00.000Z', activity: '晚' }
    ]);
    expect(rows.map((row) => row.activity)).toEqual(['晚', '早']);
  });
});
