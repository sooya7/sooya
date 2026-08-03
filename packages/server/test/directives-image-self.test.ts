import { describe, expect, it } from 'vitest';
import { StreamingDirectiveFilter, stripModelDirectives } from '../src/core/directives.js';

describe('image-self directive', () => {
  it('parses a self-photo marker into selfImagePrompt and strips it from visible text', () => {
    const r = stripModelDirectives('给你看今天的我[[image-self:站在窗边的我，穿着米色毛衣，微笑着看向镜头]]');
    expect(r.directives.selfImagePrompt).toContain('站在窗边的我');
    expect(r.directives.imagePrompt).toBeUndefined();
    expect(r.text).toBe('给你看今天的我');
  });

  it('keeps a normal image marker independent', () => {
    const r = stripModelDirectives('画一只猫[[image:窗台上睡觉的橘猫]]');
    expect(r.directives.imagePrompt).toContain('窗台上睡觉的橘猫');
    expect(r.directives.selfImagePrompt).toBeUndefined();
  });

  it('does not mistake image-self for image', () => {
    const r = stripModelDirectives('[[image-self:我的自拍]]');
    expect(r.directives.selfImagePrompt).toContain('我的自拍');
    expect(r.directives.imagePrompt).toBeUndefined();
  });

  it('streams a long self-image prompt without leaking the marker', () => {
    const filter = new StreamingDirectiveFilter();
    expect(filter.push('[[image-self:' + '我'.repeat(200))).toBe('');
    expect(filter.flush()).toBe('');
  });
});
