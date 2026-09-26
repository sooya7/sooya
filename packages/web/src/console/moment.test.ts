import { describe, expect, it } from 'vitest';
import { clockMinutes, minutesIn, phaseFor } from './Moment.js';
import { sectionIcon } from './icons.js';
import { policyReasonText } from './labels.js';

describe('her time of day', () => {
  it('reads wall-clock minutes in her zone', () => {
    // 2026-09-26T04:30:00Z is 12:30 in Shanghai
    expect(minutesIn(new Date('2026-09-26T04:30:00Z'), 'Asia/Shanghai')).toBe(12 * 60 + 30);
  });

  it('accepts sunrise as a clock string or a timestamp', () => {
    expect(clockMinutes('05:44', 'Asia/Shanghai')).toBe(5 * 60 + 44);
    expect(clockMinutes('17:46:30', 'Asia/Shanghai')).toBe(17 * 60 + 46);
    expect(clockMinutes('2026-09-25T21:44:00Z', 'Asia/Shanghai')).toBe(5 * 60 + 44);
    expect(clockMinutes('', 'Asia/Shanghai')).toBeNull();
    expect(clockMinutes('not a time', 'Asia/Shanghai')).toBeNull();
  });

  it.each([
    [5 * 60 + 30, 'dawn'],
    [12 * 60, 'day'],
    [18 * 60, 'dusk'],
    [23 * 60, 'night'],
    [2 * 60, 'night']
  ] as const)('minute %i of her day is %s', (minute, phase) => {
    expect(phaseFor(minute, 5 * 60 + 44, 17 * 60 + 46)).toBe(phase);
  });

  it('falls back to 6:00 and 18:00 without weather data', () => {
    expect(phaseFor(6 * 60, null, null)).toBe('dawn');
    expect(phaseFor(13 * 60, null, null)).toBe('day');
  });
});

describe('section glyphs', () => {
  it('prefers the specific word over the generic one', () => {
    expect(sectionIcon('清空全部记忆', 'memory')).toBe('trash');
    expect(sectionIcon('她记得的', 'memory')).toBe('bookmark');
    expect(sectionIcon('备份', 'storage')).toBe('archive');
    expect(sectionIcon('她的声音', 'persona')).toBe('mic');
  });

  it('falls back to the page icon', () => {
    expect(sectionIcon('一个没有关键词的标题', 'life')).toBe('life');
  });
});

describe('policy reasons', () => {
  it('translates known reasons and keeps unknown ones', () => {
    expect(policyReasonText('qq bot is disabled')).toBe('QQ 通道没有开启');
    expect(policyReasonText('something new')).toBe('something new');
  });
});
