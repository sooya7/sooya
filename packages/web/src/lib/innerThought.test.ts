// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getInnerThoughtMode, setInnerThoughtMode, limitToThreeSentences, nextInnerThoughtMode } from './innerThought.js';

describe('innerThought mode storage', () => {
  it('defaults to brief and persists changes', () => {
    try { localStorage.removeItem('sooya.inner-thought-mode'); } catch { /* ignore */ }
    expect(getInnerThoughtMode()).toBe('brief');
    setInnerThoughtMode('immersive');
    expect(getInnerThoughtMode()).toBe('immersive');
    setInnerThoughtMode('off');
    expect(getInnerThoughtMode()).toBe('off');
  });

  it('ignores unknown stored values and cycles off -> brief -> immersive', () => {
    try { localStorage.setItem('sooya.inner-thought-mode', 'banana'); } catch { /* ignore */ }
    expect(getInnerThoughtMode()).toBe('brief');
    expect(nextInnerThoughtMode('off')).toBe('brief');
    expect(nextInnerThoughtMode('brief')).toBe('immersive');
    expect(nextInnerThoughtMode('immersive')).toBe('off');
  });
});

describe('limitToThreeSentences', () => {
  it('keeps at most 3 sentences', () => {
    const text = '第一句。第二句！第三句？第四句。';
    expect(limitToThreeSentences(text)).toBe('第一句。 第二句！ 第三句？');
  });

  it('passes short text through', () => {
    expect(limitToThreeSentences('就一句')).toBe('就一句');
  });

  it('caps extreme length at 280 chars with an ellipsis', () => {
    const long = `${'啊'.repeat(300)}。`;
    const result = limitToThreeSentences(long);
    expect(result.length).toBeLessThanOrEqual(281);
    expect(result.endsWith('…')).toBe(true);
  });
});
