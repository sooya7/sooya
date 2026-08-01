// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer.js';
import type { StickerInfo } from '../lib/types.js';

/**
 * `Composer` 是聊天主路径上唯一没有测试的交互组件，而它握着两条最容易悄悄坏掉的规则：
 * 什么时候算「可以发送」，以及发送失败时那段草稿还在不在。
 *
 * 第一片只覆盖文本发送与表情面板（附件上传、语音、拖放粘贴留给后续分片）。
 *
 * 两个必要的搭法：
 * - textarea 是受控的，直接改 `el.value` React 看不见，必须走原型上的 value setter
 *   再派发 `input`，React 才会把新值当成用户输入收下；
 * - 表情面板里的 `AuthenticatedImage` 会自己去 `fetch` 媒体，所以桩一个返回非空图片
 *   blob 的 `fetch`，否则用例会打真实请求。
 */

const stickers: StickerInfo[] = [
  { id: 's_1', name: '笑', emotion: 'happy', tags: ['笑'], url: '/api/media/md_1', mediaId: 'md_1' }
];

let onSend: ReturnType<typeof vi.fn>;
let onNotice: ReturnType<typeof vi.fn>;
const roots: Array<{ root: Root; container: HTMLElement }> = [];
let container: HTMLElement;

interface Overrides {
  disabled?: boolean;
  stickers?: StickerInfo[];
}

async function render(over: Overrides = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => {
    root.render(
      <Composer
        disabled={over.disabled ?? false}
        stickers={over.stickers ?? stickers}
        onSend={onSend as unknown as (content: Array<Record<string, unknown>>) => Promise<unknown>}
        onNotice={onNotice as unknown as (text: string) => void}
      />
    );
  });
}

const input = () => container.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')!;
const sendBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="btn-send"]')!;
const stickerBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="btn-sticker"]')!;
const stickerPanel = () => container.querySelector('[data-testid="sticker-panel"]');
const stickerChoices = () => [...container.querySelectorAll<HTMLButtonElement>('.sticker-choice')];

/** 受控 textarea 只认原型 setter + `input` 事件，这才是「用户打字」。 */
async function type(value: string): Promise<void> {
  const el = input();
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 回车：`isComposing` 为 true 表示输入法正在选词，这一下不该发送。 */
async function pressEnter(over: { shiftKey?: boolean; isComposing?: boolean } = {}): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...over }));
    await Promise.resolve();
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

/** 手动决定 `onSend` 何时结束，用来观察发送挂起期间的中间状态。 */
function deferredSend() {
  let settle!: () => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = () => resolve();
    fail = reject;
  });
  // 未被 await 的 reject 不能让整个测试文件炸掉。
  promise.catch(() => {});
  return { promise, settle, fail };
}

/** 每次 `onSend` 收到的内容块，按调用顺序。 */
function sentContents(): Array<Array<Record<string, unknown>>> {
  return onSend.mock.calls.map((call) => call[0] as Array<Record<string, unknown>>);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onSend = vi.fn(async () => ({}));
  onNotice = vi.fn();
  // 表情图标要自己下载媒体；给一个非空的图片 blob 就够，别打真实请求。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Blob(['x'], { type: 'image/png' }), { status: 200, headers: { 'content-type': 'image/png' } }))
  );
});

afterEach(async () => {
  for (const entry of roots.splice(0)) {
    await act(async () => { entry.root.unmount(); });
    entry.container.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Composer 文本发送', () => {
  it('回车发送 trim 后的文本并清空输入框', async () => {
    await render();
    await type('  你好呀  ');

    expect(sendBtn().disabled).toBe(false);
    await pressEnter();

    expect(sentContents()).toEqual([[{ type: 'text', text: '你好呀' }]]);
    expect(input().value).toBe('');
  });

  it('点发送按钮和回车走同一条路径', async () => {
    await render();
    await type('点按钮发');
    await click(sendBtn());

    expect(sentContents()).toEqual([[{ type: 'text', text: '点按钮发' }]]);
    expect(input().value).toBe('');
  });

  it('Shift+Enter 是换行，不发送也不清空', async () => {
    await render();
    await type('第一行');
    await pressEnter({ shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(input().value).toBe('第一行');
  });

  it('输入法选词中的回车不发送 —— 否则中文打一半就被发出去', async () => {
    await render();
    await type('半句话');
    await pressEnter({ isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(input().value).toBe('半句话');

    // 选词结束后的回车照常发送。
    await pressEnter();
    expect(sentContents()).toEqual([[{ type: 'text', text: '半句话' }]]);
  });
});

describe('Composer 不可发送态', () => {
  it('只有空白字符时发送按钮禁用且回车不发送', async () => {
    await render();
    expect(sendBtn().disabled).toBe(true);

    await type('   \n  ');
    expect(sendBtn().disabled).toBe(true);

    await pressEnter();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('connection 未就绪时禁用发送并把 placeholder 换成连接中', async () => {
    await render({ disabled: true });
    expect(input().placeholder).toBe('连接中…');

    await type('连不上也想发');
    expect(sendBtn().disabled).toBe(true);

    await pressEnter();
    expect(onSend).not.toHaveBeenCalled();
    expect(input().value).toBe('连不上也想发');
  });

  it('可发送时 placeholder 是正常文案', async () => {
    await render();
    expect(input().placeholder).toBe('说点什么…');
  });
});

describe('Composer 发送中互斥与失败保草稿', () => {
  it('发送挂起期间按钮禁用，再按回车不会发出第二条', async () => {
    const pending = deferredSend();
    onSend.mockImplementation(() => pending.promise);
    await render();
    await type('别发两遍');

    await pressEnter();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(sendBtn().disabled).toBe(true);

    await pressEnter();
    await click(sendBtn());
    expect(onSend).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.settle();
      await Promise.resolve();
    });
    expect(input().value).toBe('');
  });

  it('发送失败时草稿留在输入框，按钮恢复可用', async () => {
    const pending = deferredSend();
    onSend.mockImplementation(() => pending.promise);
    await render();
    await type('这条会失败');

    await pressEnter();
    await act(async () => {
      pending.fail(new Error('offline'));
      await Promise.resolve();
    });

    // 用户不该为一次网络失败重打一遍。
    expect(input().value).toBe('这条会失败');
    expect(sendBtn().disabled).toBe(false);

    // 恢复后重发走的还是同一段草稿。
    onSend.mockImplementation(async () => ({}));
    await pressEnter();
    expect(sentContents()).toEqual([
      [{ type: 'text', text: '这条会失败' }],
      [{ type: 'text', text: '这条会失败' }]
    ]);
    expect(input().value).toBe('');
  });
});

describe('Composer 表情面板', () => {
  it('表情按钮开关面板', async () => {
    await render();
    expect(stickerPanel()).toBeNull();

    await click(stickerBtn());
    expect(stickerPanel()).not.toBeNull();
    expect(stickerChoices()).toHaveLength(1);

    await click(stickerBtn());
    expect(stickerPanel()).toBeNull();
  });

  it('点表情按 mediaId 发送并收起面板', async () => {
    await render();
    await click(stickerBtn());
    await click(stickerChoices()[0]!);

    expect(sentContents()).toEqual([[{ type: 'sticker', mediaId: 'md_1' }]]);
    expect(stickerPanel()).toBeNull();
  });

  it('没有可用表情时面板给出空态提示', async () => {
    await render({ stickers: [] });
    await click(stickerBtn());

    expect(stickerPanel()).not.toBeNull();
    expect(stickerChoices()).toHaveLength(0);
    expect(stickerPanel()!.textContent).toContain('还没有可用的表情包');
  });
});
