import { describe, expect, it } from 'vitest';
import { captureChatViewState, restoredScrollTop } from './chatViewState.js';

function viewport(scrollTop: number, scrollHeight: number, clientHeight: number): HTMLElement {
  return { scrollTop, scrollHeight, clientHeight } as HTMLElement;
}

describe('聊天视图滚动状态', () => {
  it('卸载时保存 scrollTop 与贴底语义', () => {
    expect(captureChatViewState(viewport(420, 1600, 600), false)).toEqual({ scrollTop: 420, stickToBottom: false });
    expect(captureChatViewState(null, true)).toEqual({ scrollTop: 0, stickToBottom: true });
  });

  it('贴底状态恢复到当前最大 scrollTop', () => {
    expect(restoredScrollTop(viewport(0, 1800, 600), { scrollTop: 120, stickToBottom: true })).toBe(1200);
  });

  it('读历史状态恢复原位置，并限制在当前有效范围', () => {
    const el = viewport(0, 1000, 600);
    expect(restoredScrollTop(el, { scrollTop: 240, stickToBottom: false })).toBe(240);
    expect(restoredScrollTop(el, { scrollTop: 900, stickToBottom: false })).toBe(400);
    expect(restoredScrollTop(el, { scrollTop: -20, stickToBottom: false })).toBe(0);
  });
});
