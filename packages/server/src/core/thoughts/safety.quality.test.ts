import { describe, expect, it } from 'vitest';
import { ThoughtSafetyFilter, thoughtQualityReason } from './safety.js';

describe('visible thought quality gate', () => {
  it('rejects obvious provider fragments', () => {
    expect(thoughtQualityReason('Won')).toBe('too_short_or_non_chinese');
    expect(thoughtQualityReason('(心')).toBe('too_short_or_non_chinese');
    expect(thoughtQualityReason('嗯')).toBe('too_short_or_non_chinese');
  });

  it('accepts a short natural Chinese inner thought', () => {
    expect(thoughtQualityReason('被夸得有点开心。')).toBeNull();
    expect(new ThoughtSafetyFilter().check('被夸得有点开心。')).toEqual({ safe: true });
  });

  it('rejects an obviously unclosed fragment', () => {
    expect(thoughtQualityReason('（心里突然有一点开心')).toBe('unclosed_fragment');
  });
});
