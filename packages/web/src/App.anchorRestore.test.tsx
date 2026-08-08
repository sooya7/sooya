// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView, type ChatController, type ChatViewStateRef } from './App.js';
import type { ChatMessage } from './lib/types.js';
import type { ChatViewState } from './lib/chatViewState.js';

/**
 * 可变的虚拟列表 mock：
 * - 条目由 sizes 实时计算（模拟 react-virtual 的测量缓存，测试里改 sizes 即模拟
 *   「估算 → 实测」级联或图片加载等动态高度）；
 * - scrollToIndex 直接写 scrollTop（对齐 start/end）；
 * - getBoundingClientRect 按「条目虚拟位置 - 当前 scrollTop」模拟真实布局，
 *   这样锚定修正才能像真实浏览器一样根据 scrollTop 变化收敛。
 */
const virtualizerMock = vi.hoisted(() => {
  const state = {
    sizes: [] as number[],
    items: [] as Array<{ index: number; key: string; start: number; size: number; end: number }>,
    scrollToIndex: vi.fn(),
    rebuild(sizes: number[]): void {
      state.sizes = sizes;
      let start = 0;
      state.items = sizes.map((size, index) => {
        const item = { index, key: `item-${index}`, start, size, end: start + size };
        start += size;
        return item;
      });
    }
  };
  return state;
});

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    scrollToIndex: virtualizerMock.scrollToIndex,
    getTotalSize: () => virtualizerMock.items.at(-1)?.end ?? 0,
    getVirtualItems: () => virtualizerMock.items,
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

function chatController(messages: ChatMessage[] = []): ChatController {
  return {
    messages,
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

function makeMessage(id: string, index: number): ChatMessage {
  return {
    id,
    conversationId: 'main',
    role: 'user',
    createdAt: `2026-08-07T10:00:${String(index).padStart(2, '0')}Z`,
    updatedAt: `2026-08-07T10:00:${String(index).padStart(2, '0')}Z`,
    seq: index,
    status: 'sent',
    content: [{ id: `p${index}`, type: 'text', text: `消息 ${index}`, status: 'sent' }]
  };
}

function messages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => makeMessage(`m${index}`, index));
}

// m0=100, m1=80, m2=120, m3=90, m4=110 → m2 的 start = 180。
const SIZES = [100, 80, 120, 90, 110];

function rect(top: number, bottom: number, width: number): DOMRect {
  return { top, bottom, left: 0, right: 0, width, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function installLayoutMock(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroller = document.querySelector('[data-testid="scroller"]') as HTMLElement | null;
    const scrollTop = scroller?.scrollTop ?? 0;
    if (this.getAttribute('data-testid') === 'scroller') return rect(0, 600, 800);
    // 消息栈：内容顶部 13px（padding+sentinel）相对滚动容器，随 scrollTop 上移。
    if (this.classList.contains('messages-stack')) return rect(13 - scrollTop, 600 - scrollTop, 800);
    const indexAttr = this.getAttribute('data-index');
    if (indexAttr !== null) {
      const item = virtualizerMock.items[Number(indexAttr)];
      if (!item) return rect(0, 0, 800);
      const top = item.start - scrollTop;
      return rect(top, top + item.size, 800);
    }
    return realRect.call(this);
  });
}
const realRect = HTMLElement.prototype.getBoundingClientRect;

let container: HTMLDivElement;
let root: Root;

async function renderChat(messagesList: ChatMessage[], initial: ChatViewState): Promise<ChatController> {
  const chat = chatController(messagesList);
  const viewStateRef: ChatViewStateRef = { current: initial };
  await act(async () => { root.render(<ChatView chat={chat} viewStateRef={viewStateRef} />); });
  return chat;
}

function scrollerOf(): HTMLElement {
  const scroller = container.querySelector<HTMLElement>('[data-testid="scroller"]');
  if (!scroller) throw new Error('expected ChatView scroller to be mounted');
  return scroller;
}

const ANCHORED = { messageId: 'm2', offsetFromViewportTop: 20 };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  installLayoutMock();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  virtualizerMock.items = [];
  virtualizerMock.sizes = [];
  virtualizerMock.scrollToIndex.mockClear();
});

describe('ChatView 锚点恢复', () => {
  it('stickToBottom 初始状态仍滚到底部', async () => {
    virtualizerMock.rebuild([...SIZES]);
    await renderChat(messages(5), { anchor: null, stickToBottom: true });
    expect(virtualizerMock.scrollToIndex).toHaveBeenCalledWith(4, { align: 'end' });
  });

  it('恢复路径：scrollToIndex 到锚点并按偏移修正', async () => {
    virtualizerMock.rebuild([...SIZES]);
    await renderChat(messages(5), { anchor: { ...ANCHORED }, stickToBottom: false });
    // 先跳到 m2 顶边（scrollTop = 180），再修正 -20 → 160，m2 顶边停在视口 20px。
    expect(virtualizerMock.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
    expect(scrollerOf().scrollTop).toBe(160);
  });

  it('锚点前方条目高度变化（测量级联）后锚点不漂移', async () => {
    virtualizerMock.rebuild([...SIZES]);
    await renderChat(messages(5), { anchor: { ...ANCHORED }, stickToBottom: false });
    const scroller = scrollerOf();
    expect(scroller.scrollTop).toBe(160);

    // 模拟测量级联：m0 100→160、m1 80→100，锚点前方整体 +80 → m2.start = 260。
    virtualizerMock.rebuild([160, 100, 120, 90, 110]);
    await renderChat(messages(5), { anchor: { ...ANCHORED }, stickToBottom: false });
    // 修正把 scrollTop 追到 240，m2 顶边仍停在视口 20px（不漂移）。
    expect(scroller.scrollTop).toBe(240);
  });

  it('SSE 追加新消息后锚点不漂移', async () => {
    virtualizerMock.rebuild([...SIZES]);
    await renderChat(messages(5), { anchor: { ...ANCHORED }, stickToBottom: false });
    const scroller = scrollerOf();
    expect(scroller.scrollTop).toBe(160);

    // 模拟 SSE：m5、m6 追加到末尾，锚点前方位置不变。
    virtualizerMock.rebuild([...SIZES, 100, 90]);
    await renderChat(messages(7), { anchor: { ...ANCHORED }, stickToBottom: false });
    expect(scroller.scrollTop).toBe(160);
  });

  it('锚点自身高度变化（图片加载）不漂移', async () => {
    virtualizerMock.rebuild([...SIZES]);
    await renderChat(messages(5), { anchor: { ...ANCHORED }, stickToBottom: false });
    const scroller = scrollerOf();
    expect(scroller.scrollTop).toBe(160);

    // 模拟锚点消息里的图片加载完成：m2 120→200。顶边锚定 → 顶边位置不变。
    virtualizerMock.rebuild([100, 80, 200, 90, 110]);
    await renderChat(messages(5), { anchor: { ...ANCHORED }, stickToBottom: false });
    expect(scroller.scrollTop).toBe(160);
  });

  it('锚点消息不存在时回到顶部', async () => {
    virtualizerMock.rebuild([...SIZES]);
    await renderChat(messages(5), { anchor: { messageId: 'm-gone', offsetFromViewportTop: 20 }, stickToBottom: false });
    expect(scrollerOf().scrollTop).toBe(0);
    expect(virtualizerMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it('用户主动滚动后解除锚定，不再回拉', async () => {
    virtualizerMock.rebuild([...SIZES]);
    await renderChat(messages(5), { anchor: { ...ANCHORED }, stickToBottom: false });
    const scroller = scrollerOf();
    expect(scroller.scrollTop).toBe(160);

    // 用户滚动（wheel 手势 → 解除锚定），随后位置不再被回拉。
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 520 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 200 });
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));

    // 之后前方条目高度变化不再回拉。
    virtualizerMock.rebuild([160, 100, 120, 90, 110]);
    await renderChat(messages(5), { anchor: { ...ANCHORED }, stickToBottom: false });
    expect(scroller.scrollTop).toBe(100);
  });

  it('离开时捕获视口顶部第一条可见消息为锚点', async () => {
    virtualizerMock.rebuild([...SIZES]);
    const chat = chatController(messages(5));
    const viewStateRef: ChatViewStateRef = { current: { anchor: null, stickToBottom: false } };
    await act(async () => { root.render(<ChatView chat={chat} viewStateRef={viewStateRef} />); });
    const scroller = scrollerOf();
    scroller.scrollTop = 140; // m0（0..100）完全滚出，m1 顶边在视口上方 27px（含 13px 内容头）。

    await act(async () => { root.render(null); });

    expect(viewStateRef.current).toEqual({ anchor: { messageId: 'm1', offsetFromViewportTop: -27 }, stickToBottom: false });
  });
});
