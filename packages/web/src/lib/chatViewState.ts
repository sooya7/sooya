/**
 * 聊天视图滚动状态的「锚点」模型。
 *
 * 旧实现保存绝对 scrollTop，恢复时在虚拟列表的「估算 → 实测」级联（ResizeObserver
 * 条目测高校正）完成前执行，min(max, target) 会把位置钳到部分 max，之后没有
 * 修正机制，位置丢失（见 docs/E2E-ISSUE-SCROLL-RESTORE.md）。
 *
 * 新模型改为保存「视口顶部第一条可见消息」作为锚点：messageId（虚拟列表
 * getItemKey 同源，跨重挂载稳定）+ 该消息顶边相对视口顶部的偏移。恢复时先
 * scrollToIndex 到锚点，再由 ChatView 的锚定保持期按 DOM 实测位置持续修正，
 * 直到测量级联收敛——锚点前方的消息高度怎么变，锚点消息都停在原偏移。
 */

export interface ChatScrollAnchor {
  /** 锚点消息 id（虚拟列表 getItemKey 同源，跨重挂载稳定）。 */
  messageId: string;
  /** 锚点消息顶边相对视口顶部的偏移（px，可为负：顶边滚到视口上方）。 */
  offsetFromViewportTop: number;
}

export interface ChatViewState {
  anchor: ChatScrollAnchor | null;
  stickToBottom: boolean;
}

export const INITIAL_CHAT_VIEW_STATE: ChatViewState = Object.freeze({ anchor: null, stickToBottom: true });

/** 虚拟列表条目的最小接口（兼容 @tanstack/react-virtual 的 VirtualItem）。 */
export interface VirtualItemLike {
  index: number;
  start: number;
  size: number;
  end: number;
}

export function captureChatViewState(options: {
  scrollTop: number;
  /** 虚拟内容容器顶边相对滚动容器内容顶部的偏移（滚动容器 padding + 头部提示等）。 */
  contentOffsetTop: number;
  virtualItems: VirtualItemLike[];
  stickToBottom: boolean;
  /** 由条目下标取消息 id（调用方提供，避免本模块依赖消息模型）。 */
  getMessageId: (index: number) => string | null;
}): ChatViewState {
  if (options.stickToBottom) return { anchor: null, stickToBottom: true };
  const firstVisible = options.virtualItems.find((item) => options.contentOffsetTop + item.end > options.scrollTop);
  if (!firstVisible) return { anchor: null, stickToBottom: false };
  const messageId = options.getMessageId(firstVisible.index);
  if (!messageId) return { anchor: null, stickToBottom: false };
  return {
    anchor: {
      messageId,
      offsetFromViewportTop: options.contentOffsetTop + firstVisible.start - options.scrollTop
    },
    stickToBottom: false
  };
}

/**
 * 锚点恢复的滚动修正量。
 *
 * 目标：锚点消息顶边停在 offsetFromViewportTop；当前顶边在 anchorTopInViewport
 * （均由 DOM rect 实测）。scrollTop 增加 d 会让内容上移 d（顶边在视口中的位置
 * 减 d），因此修正量 = 当前 - 目标，调用方执行 `scrollTop += 修正量`。
 */
export function anchorScrollCorrection(anchorTopInViewport: number, offsetFromViewportTop: number): number {
  return anchorTopInViewport - offsetFromViewportTop;
}

/** 锚点是否已稳定在保存的偏移（半像素容差内视为到位）。 */
export function isAnchorSettled(anchorTopInViewport: number, offsetFromViewportTop: number): boolean {
  return Math.abs(anchorTopInViewport - offsetFromViewportTop) < 0.5;
}
