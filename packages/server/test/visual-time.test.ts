import { describe, expect, it } from 'vitest';
import {
  ensureVisualTimeReplyText,
  resolveVisualTime,
  visualDayPeriodLighting,
  visualTimeMetadata,
  visualTimeReplyInstruction,
  visualDayPeriodOfHour,
  requestedVisualDayPeriod
} from '../src/core/visual-time.js';

const NOW = '2026-08-26T05:17:00.000Z';

describe('visual time resolver', () => {
  it.each([
    [0, 'late-night'], [4, 'late-night'], [5, 'morning'], [10, 'morning'],
    [11, 'midday'], [13, 'midday'], [14, 'afternoon'], [17, 'afternoon'],
    [18, 'evening'], [23, 'evening']
  ])('uses half-open period boundary at %i:00', (hour, period) => {
    expect(visualDayPeriodOfHour(hour)).toBe(period);
  });

  it('resolves a current request in the local zone', () => {
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: '再来一张' })).toMatchObject({
      timeZone: 'Asia/Shanghai', currentInstant: NOW, currentLocalDate: '2026-08-26',
      currentLocalTime: '13:17:00', currentDayPeriod: 'midday', mode: 'current',
      depictedLocalDate: '2026-08-26', depictedDayPeriod: 'midday', requestedDayPeriod: null
    });
  });

  it.each(['晚上睡觉的照片', '今晚睡觉那种', 'a sleeping photo at night'])('recognizes retrospective sleep imagery: %s', (text) => {
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: text })).toMatchObject({
      mode: 'retrospective', depictedLocalDate: '2026-08-25', depictedDayPeriod: 'evening', requestedDayPeriod: 'evening'
    });
  });

  it('keeps sleep imagery current when the real clock is already evening', () => {
    expect(resolveVisualTime({ now: '2026-08-26T12:30:00.000Z', timeZone: 'Asia/Shanghai', latestUserText: '晚上睡觉的照片' })).toMatchObject({
      mode: 'current', depictedLocalDate: '2026-08-26', depictedDayPeriod: 'evening'
    });
  });

  it.each(['凌晨', '深夜', 'late-night', 'late night'])('recognizes late-night request period: %s', (text) => {
    expect(requestedVisualDayPeriod(text)).toBe('late-night');
  });

  it('keeps an explicit night scenery request current', () => {
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: '来一张夜景' })).toMatchObject({
      mode: 'current', depictedLocalDate: '2026-08-26', depictedDayPeriod: 'midday', requestedDayPeriod: 'evening'
    });
  });

  it.each(['昨天的照片', '昨晚睡觉那种', 'a photo from yesterday', 'a photo from last night'])('moves explicit past wording to the previous local date: %s', (text) => {
    const result = resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: text });
    expect(result.mode).toBe('retrospective');
    expect(result.depictedLocalDate).toBe('2026-08-25');
  });

  it('uses an active event instant as the depicted local time', () => {
    expect(resolveVisualTime({ now: '2026-08-26T10:30:00.000Z', eventAt: '2026-08-26T06:00:00.000Z', timeZone: 'Asia/Shanghai' })).toMatchObject({
      mode: 'retrospective', depictedLocalDate: '2026-08-26', depictedDayPeriod: 'afternoon', currentLocalTime: '18:30:00', currentDayPeriod: 'evening'
    });
  });

  it('handles invalid zones conservatively without throwing', () => {
    expect(resolveVisualTime({ now: NOW, timeZone: 'Not/AZone', latestUserText: '夜景' })).toMatchObject({
      timeZone: 'Not/AZone', currentLocalDate: '2026-08-26', currentLocalTime: '05:17:00', currentDayPeriod: 'morning', mode: 'current', requestedDayPeriod: null
    });
  });

  it('ignores an invalid event instant', () => {
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', eventAt: 'not-a-date' })).toMatchObject({ mode: 'current', depictedLocalDate: '2026-08-26' });
  });

  it('projects metadata and gives stable reply guidance and fallback wording', () => {
    const time = resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: '昨晚睡觉那种' });
    expect(visualTimeMetadata(time)).toEqual({ timeMode: 'retrospective', timeZone: 'Asia/Shanghai', currentInstant: NOW, currentDayPeriod: 'midday', depictedLocalDate: '2026-08-25', depictedDayPeriod: 'evening', requestedDayPeriod: 'evening' });
    expect(visualTimeReplyInstruction(time)).toContain('真实时间不可被改写');
    expect(ensureVisualTimeReplyText('我给你一张照片。', time, true)).toBe('现在还是中午，不过昨天倒是有一张这种。');
    expect(ensureVisualTimeReplyText('昨天我给你一张照片。', time, true)).toBe('昨天我给你一张照片。');
    expect(ensureVisualTimeReplyText('昨日倒是拍了一张。', time, true)).toBe('昨日倒是拍了一张。');
    expect(ensureVisualTimeReplyText('I took this earlier.', time, true)).toBe('I took this earlier.');
    expect(ensureVisualTimeReplyText('我给你一张照片。', time, false)).toBe('我给你一张照片。');
    expect(visualDayPeriodLighting('evening')).toMatch(/English|warm|twilight|evening/i);
    expect(requestedVisualDayPeriod('再来一张')).toBeNull();
  });
});
