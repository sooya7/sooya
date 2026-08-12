import { describe, expect, it } from 'vitest';
import { isDisplayableThoughtText } from '../src/core/thoughts/quality.js';

describe('visible thought quality gate', () => {
  it('rejects provider debris and visibly truncated fragments', () => {
    expect(isDisplayableThoughtText('')).toBe(false);
    expect(isDisplayableThoughtText('Won')).toBe(false);
    expect(isDisplayableThoughtText('(心')).toBe(false);
    expect(isDisplayableThoughtText('（心里有点开心')).toBe(false);
  });

  it('accepts short complete Chinese thoughts', () => {
    expect(isDisplayableThoughtText('有点想逗逗他。')).toBe(true);
    expect(isDisplayableThoughtText('（被这个表情逗笑了）')).toBe(true);
    expect(isDisplayableThoughtText('嘴上不说，心里其实挺开心的。')).toBe(true);
  });

  it('rejects unbalanced wrappers even when the text is otherwise long enough', () => {
    expect(isDisplayableThoughtText('想靠近一点（但又有点害羞。')).toBe(false);
    expect(isDisplayableThoughtText('想看看他今天在做什么【偷偷好奇。')).toBe(false);
  });
});
