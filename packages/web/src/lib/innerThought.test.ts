// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getInnerThoughtMode, setInnerThoughtMode, limitToThreeSentences, nextInnerThoughtMode } from './innerThought.js';

describe('innerThought legacy mode compatibility', () => {
  it('always resolves to brief and clears stale stored modes', () => {
    try { localStorage.setItem('sooya.inner-thought-mode', 'immersive'); } catch { /* ignore */ }
    expect(getInnerThoughtMode()).toBe('brief');
    expect(localStorage.getItem('sooya.inner-thought-mode')).toBeNull();

    setInnerThoughtMode('off');
    expect(getInnerThoughtMode()).toBe('brief');
    expect(localStorage.getItem('sooya.inner-thought-mode')).toBeNull();
  });

  it('keeps the compatibility cycle shim pinned to brief', () => {
    try { localStorage.setItem('sooya.inner-thought-mode', 'banana'); } catch { /* ignore */ }
    expect(getInnerThoughtMode()).toBe('brief');
    expect(nextInnerThoughtMode('off')).toBe('brief');
    expect(nextInnerThoughtMode('brief')).toBe('brief');
    expect(nextInnerThoughtMode('immersive')).toBe('brief');
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
