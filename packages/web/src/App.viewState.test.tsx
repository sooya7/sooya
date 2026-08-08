// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView, type ChatController, type ChatViewStateRef } from './App.js';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    scrollToIndex: vi.fn(),
    getTotalSize: () => 0,
    getVirtualItems: () => [],
    measureElement: vi.fn()
  })
}));

vi.mock('./lib/useAuthenticatedMedia.js', () => ({
  useAuthenticatedMedia: () => ({ url: null, error: null, loading: false, retriable: false, retry: vi.fn() })
}));

vi.mock('./components/NotificationBridge.js', () => ({ NotificationBridge: () => null }));
vi.mock('./components/MessageItem.js', () => ({ MessageItem: () => null }));
vi.mock('./components/Composer.js', () => ({ Composer: () => null }));
vi.mock('./components/DateSeparator.js', () => ({ DateSeparator: () => null }));

function chatController(): ChatController {
  return {
    messages: [],
    persona: null,
    connection: 'online',
    activity: { thinking: false, label: null },
    life: null,
    stickers: [],
    quotedStates: {},
    replyFailures: {},
    hasMore: false,
    loadingOlder: false,
    error: null,
    ready: true,
    send: vi.fn(),
    retryFailed: vi.fn(),
    sendAgain: vi.fn(),
    withdraw: vi.fn(),
    loadOlder: vi.fn(),
    ensureQuotedMessage: vi.fn(),
    addMessages: vi.fn(),
    resync: vi.fn(),
    reload: vi.fn(),
    clearError: vi.fn()
  } as unknown as ChatController;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ChatView 视图状态生命周期', () => {
  it('active 从 true 变为 false 时按锚点模型保存视图状态', async () => {
    const chat = chatController();
    const viewStateRef: ChatViewStateRef = { current: { anchor: null, stickToBottom: false } };
    const render = (active: boolean) => active ? <ChatView chat={chat} viewStateRef={viewStateRef} /> : null;

    await act(async () => { root.render(render(true)); });
    const scroller = container.querySelector<HTMLElement>('[data-testid="scroller"]');
    if (!scroller) throw new Error('expected ChatView scroller to be mounted');
    scroller.scrollTop = 321;

    await act(async () => { root.render(render(false)); });

    // 虚拟列表 mock 无条目 → 没有可见消息可作锚点 → 退化为无锚点（顶部恢复）。
    expect(viewStateRef.current).toEqual({ anchor: null, stickToBottom: false });
  });
});
