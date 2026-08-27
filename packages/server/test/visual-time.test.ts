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

  it.each([undefined, '', '   '])('defaults missing/blank time zone to Shanghai (%s)', (timeZone) => {
    expect(resolveVisualTime({ now: NOW, timeZone })).toMatchObject({ timeZone: 'Asia/Shanghai', currentLocalTime: '13:17:00' });
  });

  it.each([
    ['早上来一张', 'morning'], ['下午来一张', 'afternoon'], ['晚上来一张', 'evening']
  ])('retrospects an ordinary conflicting period request: %s', (text, period) => {
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: text })).toMatchObject({ mode: 'retrospective', depictedLocalDate: '2026-08-25', depictedDayPeriod: period });
  });

  it('ignores future, null, and invalid event instants', () => {
    for (const eventAt of ['2026-08-26T06:00:00.000Z', null, 'invalid']) {
      expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', eventAt, latestUserText: '早上来一张' })).toMatchObject({ mode: 'retrospective', depictedLocalDate: '2026-08-25', depictedDayPeriod: 'morning' });
    }
  });

  it('keeps a same-local-date same-period event current and ignores text', () => {
    expect(resolveVisualTime({ now: '2026-08-26T10:30:00.000Z', eventAt: '2026-08-26T10:00:00.000Z', timeZone: 'Asia/Shanghai', latestUserText: '昨晚睡觉' })).toMatchObject({ mode: 'current', depictedLocalDate: '2026-08-26', depictedDayPeriod: 'evening', requestedDayPeriod: null });
  });

  it('rejects an invalid now instant', () => {
    expect(() => resolveVisualTime({ now: 'invalid', timeZone: 'Asia/Shanghai' })).toThrow(new RangeError('invalid visual time now'));
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

  it('retrospects an explicit night scenery request when it conflicts with current time', () => {
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: '来一张夜景' })).toMatchObject({
      mode: 'retrospective', depictedLocalDate: '2026-08-25', depictedDayPeriod: 'evening', requestedDayPeriod: 'evening'
    });
  });

  it.each(['半夜', 'after midnight'])('recognizes additional late-night expressions: %s', (text) => expect(requestedVisualDayPeriod(text)).toBe('late-night'));
  it.each(['清晨', '早晨', '早上', '上午', 'morning'])('recognizes morning expression: %s', (text) => expect(requestedVisualDayPeriod(text)).toBe('morning'));
  it.each(['中午', '午间', '正午', 'noon', 'midday'])('recognizes midday expression: %s', (text) => expect(requestedVisualDayPeriod(text)).toBe('midday'));
  it.each(['下午', '午后', 'afternoon'])('recognizes afternoon expression: %s', (text) => expect(requestedVisualDayPeriod(text)).toBe('afternoon'));
  it.each(['傍晚', '晚上', '今晚', '夜里', '夜晚', '睡前', '晚安', 'evening', 'tonight', 'at night', 'nighttime', 'bedtime'])('recognizes evening expression: %s', (text) => expect(requestedVisualDayPeriod(text)).toBe('evening'));
  it('does not match nightmare or past-tense-looking instruction prose', () => {
    expect(requestedVisualDayPeriod('nightmare')).toBeNull();
    expect(requestedVisualDayPeriod('Before generating, use an evening scene')).toBe('evening');
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: 'Before generating, use a photo' }).mode).toBe('current');
    expect(ensureVisualTimeReplyText('Earlier, generate a photo.', resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: '晚上睡觉' }), true)).toBe('现在还是中午，不过昨天倒是有一张这种。');
  });

  it('does not treat nightmare as a sleep time request', () => {
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: 'sleeping nightmare' })).toMatchObject({ requestedDayPeriod: null, mode: 'current' });
  });

  it('recognizes bounded sleep night expressions', () => {
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: 'sleep photo at night' })).toMatchObject({ requestedDayPeriod: 'evening', mode: 'retrospective' });
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: 'sleep photo late at night' })).toMatchObject({ requestedDayPeriod: 'late-night', mode: 'retrospective' });
    expect(resolveVisualTime({ now: NOW, timeZone: 'Asia/Shanghai', latestUserText: '深夜睡觉照片' })).toMatchObject({ requestedDayPeriod: 'late-night', mode: 'retrospective' });
  });

  it('accepts null optional inputs conservatively', () => {
    expect(resolveVisualTime({ now: NOW, timeZone: null, latestUserText: null })).toMatchObject({ timeZone: 'Asia/Shanghai', currentLocalTime: '13:17:00', requestedDayPeriod: null, mode: 'current' });
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
    expect(visualTimeReplyInstruction(time)).toContain('2026-08-26');
    expect(visualTimeReplyInstruction(time)).toContain('13:17:00');
    expect(visualTimeReplyInstruction(time)).toContain('Asia/Shanghai');
    expect(visualTimeReplyInstruction(time)).toContain('2026-08-25');
    expect(ensureVisualTimeReplyText('我给你一张照片。', time, true)).toBe('现在还是中午，不过昨天倒是有一张这种。');
    expect(ensureVisualTimeReplyText('昨天我给你一张照片。', time, true)).toBe('昨天我给你一张照片。');
    expect(ensureVisualTimeReplyText('昨日倒是拍了一张。', time, true)).toBe('昨日倒是拍了一张。');
    expect(ensureVisualTimeReplyText('I took this earlier.', time, true)).toBe('I took this earlier.');
    expect(ensureVisualTimeReplyText('昨夜倒是拍了一张。', time, true)).toBe('昨夜倒是拍了一张。');
    expect(ensureVisualTimeReplyText('那天倒是拍了一张。', time, true)).toBe('那天倒是拍了一张。');
    expect(ensureVisualTimeReplyText('I took this the previous day.', time, true)).toBe('I took this the previous day.');
    for (const wording of ['昨天', '昨日', '昨晚', '昨夜', '之前', '当时', '那天', '前一晚', 'yesterday', 'last night', 'earlier']) {
      const reply = `${wording}倒是拍了一张。`;
      expect(ensureVisualTimeReplyText(reply, time, true), wording).toBe(reply);
    }
    expect(ensureVisualTimeReplyText('我给你一张照片。', time, true)).toBe('现在还是中午，不过昨天倒是有一张这种。');
    expect(ensureVisualTimeReplyText('我给你一张照片。', time, false)).toBe('我给你一张照片。');
    expect(visualDayPeriodLighting('evening')).toMatch(/English|warm|twilight|evening/i);
    expect(requestedVisualDayPeriod('再来一张')).toBeNull();
  });
});
