import { describe, expect, it } from 'vitest';
import { stripModelDirectivesForDisplay } from './messageDirectives.js';

describe('stripModelDirectivesForDisplay', () => {
  it('hides a long image prompt while preserving surrounding prose', () => {
    expect(stripModelDirectivesForDisplay('我来试试 [[image:A young woman sleeping peacefully in bed, with a corgi plushie]] 好啦')).toBe('我来试试 好啦');
  });

  it('hides a marker-only text part so the generated image can stand alone', () => {
    expect(stripModelDirectivesForDisplay('[[image:A sunny daytime room with a notebook]]')).toBe('');
  });

  it('hides Chinese protocol aliases from historical messages', () => {
    expect(stripModelDirectivesForDisplay('我来啦 [表情包:委屈巴巴]')).toBe('我来啦');
  });

  it('does not remove ordinary bracketed text', () => {
    expect(stripModelDirectivesForDisplay('数组 arr[[0]] 和 [备注] 都是普通文字')).toBe('数组 arr[[0]] 和 [备注] 都是普通文字');
  });
});
