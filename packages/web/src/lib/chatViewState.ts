export interface ChatViewState {
  scrollTop: number;
  stickToBottom: boolean;
}

export const INITIAL_CHAT_VIEW_STATE: ChatViewState = Object.freeze({ scrollTop: 0, stickToBottom: true });

export function captureChatViewState(element: HTMLElement | null, stickToBottom: boolean): ChatViewState {
  return { scrollTop: Math.max(0, element?.scrollTop ?? 0), stickToBottom };
}

export function restoredScrollTop(element: HTMLElement, state: ChatViewState): number {
  const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
  if (state.stickToBottom) return maximum;
  return Math.min(maximum, Math.max(0, state.scrollTop));
}
