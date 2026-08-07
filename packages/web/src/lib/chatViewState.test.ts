import { describe, expect, it } from 'vitest';
import { anchorScrollCorrection, captureChatViewState, isAnchorSettled } from './chatViewState.js';

const items = [
  { index: 0, start: 0, size: 100, end: 100 },
  { index: 1, start: 100, size: 80, end: 180 },
  { index: 2, start: 180, size: 120, end: 300 }
];
const getMessageId = (index: number) => `m${index}`;

describe('聊天视图滚动锚点', () => {
  it('贴底时只保存 stickToBottom，不取锚点', () => {
    expect(captureChatViewState({ scrollTop: 500, contentOffsetTop: 0, virtualItems: items, stickToBottom: true, getMessageId }))
      .toEqual({ anchor: null, stickToBottom: true });
  });

  it('离开时以视口顶部第一条可见消息为锚点（顶边在视口上方时偏移为负）', () => {
    // scrollTop=140：第 0 条（0..100）已完全滚出，第 1 条顶边在视口上方 40px。
    expect(captureChatViewState({ scrollTop: 140, contentOffsetTop: 0, virtualItems: items, stickToBottom: false, getMessageId }))
      .toEqual({ anchor: { messageId: 'm1', offsetFromViewportTop: -40 }, stickToBottom: false });
  });

  it('滚动进条目中间时偏移为条目顶边到视口顶部的距离', () => {
    // scrollTop=210：第 2 条（180..300）可见，顶边在视口上方 30px。
    expect(captureChatViewState({ scrollTop: 210, contentOffsetTop: 0, virtualItems: items, stickToBottom: false, getMessageId }))
      .toEqual({ anchor: { messageId: 'm2', offsetFromViewportTop: -30 }, stickToBottom: false });
  });

  it('内容区顶部有偏移（padding/提示条）时计入锚点偏移', () => {
    // contentOffsetTop=40、scrollTop=30：第一条可见（40+100 > 30），顶边在视口下方 10px。
    expect(captureChatViewState({ scrollTop: 30, contentOffsetTop: 40, virtualItems: items, stickToBottom: false, getMessageId }))
      .toEqual({ anchor: { messageId: 'm0', offsetFromViewportTop: 10 }, stickToBottom: false });
  });

  it('所有条目都在视口上方时退化为无锚点（顶部恢复）', () => {
    expect(captureChatViewState({ scrollTop: 5000, contentOffsetTop: 0, virtualItems: items, stickToBottom: false, getMessageId }))
      .toEqual({ anchor: null, stickToBottom: false });
  });

  it('条目取不到消息 id 时退化为无锚点', () => {
    expect(captureChatViewState({ scrollTop: 140, contentOffsetTop: 0, virtualItems: items, stickToBottom: false, getMessageId: () => null }))
      .toEqual({ anchor: null, stickToBottom: false });
  });

  it('修正量 = 当前顶边位置 - 目标偏移，scrollTop += 修正量 即完成锚定', () => {
    // 锚点顶边在视口 80px 处、目标 20px → 内容需上移 60px（scrollTop += 60）。
    expect(anchorScrollCorrection(80, 20)).toBe(60);
    // 锚点顶边在视口顶部（scrollToIndex 后）、目标 40px → 内容需下移 40px。
    expect(anchorScrollCorrection(0, 40)).toBe(-40);
    // 负偏移（顶边在视口上方）同样成立：当前在顶部、目标 -30 → scrollTop += 30。
    expect(anchorScrollCorrection(0, -30)).toBe(30);
  });

  it('isAnchorSettled 在半像素容差内视为稳定', () => {
    expect(isAnchorSettled(20.4, 20)).toBe(true);
    expect(isAnchorSettled(20.5, 20)).toBe(false);
    expect(isAnchorSettled(21, 20)).toBe(false);
  });
});
