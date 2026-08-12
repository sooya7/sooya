// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getInnerThoughtMode } from './innerThought.js';

describe('inner thought legacy mode migration', () => {
  beforeEach(() => localStorage.clear());

  it('migrates immersive to the single collapsed-by-default mode', () => {
    localStorage.setItem('sooya.inner-thought-mode', 'immersive');
    expect(getInnerThoughtMode()).toBe('brief');
    expect(localStorage.getItem('sooya.inner-thought-mode')).toBe('brief');
  });
});
