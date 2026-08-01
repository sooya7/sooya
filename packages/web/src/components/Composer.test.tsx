// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer.js';
import type { MediaRef, StickerInfo } from '../lib/types.js';

vi.mock('./VoiceRecorder.js', () => ({
  VoiceRecorder: ({
    onReady,
    onCancel
  }: {
    onReady: (media: MediaRef) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="mock-recorder">
      <button type="button" data-testid="mock-voice-cancel" onClick={onCancel}>
        cancel
      </button>
      <button
        type="button"
        data-testid="mock-voice-ready"
        onClick={() => onReady(media('audio', 'md_voice', { duration: 4.6, transcript: 'voice text' }))}
      >
        ready
      </button>
    </div>
  )
}));

/**
 * `Composer` 是聊天主路径上唯一没有测试的交互组件，而它握着几条最容易悄悄坏掉的规则：
 * 什么时候算「可以发送」、发送失败时那段草稿还在不在，以及上传回来的媒体怎么变成内容块。
 *
 * 已覆盖：文本发送、表情面板、附件上传与附件条、拖放与粘贴（语音留给后续分片）。
 *
 * 几个必要的搭法：
 * - textarea 是受控的，直接改 `el.value` React 看不见，必须走原型上的 value setter
 *   再派发 `input`，React 才会把新值当成用户输入收下；
 * - `input[type=file]` 的 `files` 在 jsdom 里是只读的，也没有可用的 `DataTransfer`，
 *   所以用 `Object.defineProperty` 盖掉 `files` 再派发 `change`（React 对文件输入只听 `change`）；
 * - `AuthenticatedImage` 会自己去 `fetch` 媒体再走 `URL.createObjectURL`，jsdom 没有后者，
 *   所以两样都要桩：`fetch` 按路由分派（`POST /api/media` 是上传，其余当媒体下载），
 *   `createObjectURL` 给一个假 blob URL，`<img>` 才会真的渲染出来。
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
const voiceBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="btn-voice"]')!;
const composerRow = () => container.querySelector('.composer-row');
const recorder = () => container.querySelector('[data-testid="mock-recorder"]');
const voiceCancelBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="mock-voice-cancel"]')!;
const voiceReadyBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="mock-voice-ready"]')!;
const stickerBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="btn-sticker"]')!;
const stickerPanel = () => container.querySelector('[data-testid="sticker-panel"]');
const stickerChoices = () => [...container.querySelectorAll<HTMLButtonElement>('.sticker-choice')];
const imageInput = () => container.querySelector<HTMLInputElement>('[data-testid="input-image"]')!;
const fileInput = () => container.querySelector<HTMLInputElement>('[data-testid="input-file"]')!;
const strip = () => container.querySelector('[data-testid="attachment-strip"]');
const attachmentItems = () => [...container.querySelectorAll<HTMLElement>('.attachment')];
const removeBtns = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="移除附件"]')];
const hint = () => container.querySelector('.composer-hint');

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

/** 让所有挂起的 promise（含 `api.upload` 里 fetch → text → JSON 那串）跑完并让 React 重渲染。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function file(name: string, type: string): File {
  return new File(['bytes'], name, { type });
}

function media(kind: MediaRef['kind'], id: string, over: Partial<MediaRef> = {}): MediaRef {
  return {
    id,
    kind,
    mime: kind === 'audio' ? 'audio/webm' : kind === 'file' ? 'application/pdf' : 'image/png',
    bytes: 1024,
    url: `/api/media/${id}`,
    name: `${id}.bin`,
    ...over
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `POST /api/media` 收到的 `FormData`，按调用顺序；断言字段名推断用它。 */
let uploadForms: FormData[];
/** 本用例希望上传怎么应答；默认一张图片成功。 */
let uploadHandler: () => Promise<Response>;

/** 把上传卡在挂起态，用来观察「正在上传…」这类中间状态。 */
function deferredUpload(body: unknown) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  uploadHandler = async () => { await gate; return jsonResponse(body); };
  return { open };
}

/** jsdom 里 `input.files` 只读，只能盖掉属性再派发 `change`（React 对文件输入只听这个）。 */
async function selectFiles(el: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(el, 'files', { configurable: true, value: files });
  await act(async () => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const composer = () => container.querySelector<HTMLElement>('.composer')!;

/**
 * jsdom 没有可用的 `DragEvent` / `DataTransfer`：派发普通事件，再把 `dataTransfer`
 * 挂到事件对象上（React 的合成事件就是从 nativeEvent 读这个属性）。
 */
async function drag(type: 'dragover' | 'dragleave' | 'drop', files: File[] = []): Promise<void> {
  const evt = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'dataTransfer', { value: { files } });
  await act(async () => {
    composer().dispatchEvent(evt);
  });
}

/**
 * 粘贴：`clipboardData.items` 只需要给出 `kind` 与 `getAsFile()`。
 * 返回事件本身，便于断言 `defaultPrevented`（粘贴文件要拦截默认行为，纯文本不能拦）。
 */
async function paste(items: Array<{ kind: 'file' | 'string'; file?: File | null }>): Promise<Event> {
  const evt = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'clipboardData', {
    value: { items: items.map((i) => ({ kind: i.kind, getAsFile: () => i.file ?? null })) }
  });
  await act(async () => {
    input().dispatchEvent(evt);
  });
  return evt;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onSend = vi.fn(async () => ({}));
  onNotice = vi.fn();
  uploadForms = [];
  uploadHandler = async () => jsonResponse({ media: [media('image', 'md_up')], failed: [] });
  // 上传和媒体下载共用一个 fetch 桩：按路由分派，都不打真实请求。
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init: RequestInit = {}) => {
      const url = String(input);
      if (url === '/api/media' && (init.method ?? 'GET').toUpperCase() === 'POST') {
        uploadForms.push(init.body as FormData);
        return uploadHandler();
      }
      // 表情图标和附件缩略图要自己下载媒体；给几个非空字节就够。
      // 注意别用 jsdom 的 `Blob` 造 `Response`：它没有 `stream()`，undici 会直接抛 TypeError，
      // 结果是媒体一律加载失败，而组件只会安静地渲染占位。
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
    })
  );
  // jsdom 没有 createObjectURL，缺了它 `AuthenticatedImage` 会退化成「图片不可用」。
  const urlCtor = URL as unknown as Record<string, unknown>;
  urlCtor.createObjectURL = vi.fn(() => 'blob:sooya/mock');
  urlCtor.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  for (const entry of roots.splice(0)) {
    await act(async () => { entry.root.unmount(); });
    entry.container.remove();
  }
  const urlCtor = URL as unknown as Record<string, unknown>;
  delete urlCtor.createObjectURL;
  delete urlCtor.revokeObjectURL;
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

describe('Composer 附件上传', () => {
  it('选图片后打一次上传请求，挂起期间显示正在上传，完成后出现附件条', async () => {
    const gate = deferredUpload({ media: [media('image', 'md_a')], failed: [] });
    await render();

    await selectFiles(imageInput(), [file('cat.png', 'image/png')]);
    expect(uploadForms).toHaveLength(1);
    expect(hint()?.textContent).toBe('正在上传…');
    expect(strip()).toBeNull();

    await act(async () => { gate.open(); });
    await flush();

    expect(uploadForms).toHaveLength(1);
    expect(strip()).not.toBeNull();
    expect(attachmentItems()).toHaveLength(1);
    expect(hint()).toBeNull();
  });

  it('上传后清空 input，同一个文件能再选一次', async () => {
    await render();
    const picked = file('cat.png', 'image/png');
    // 文件输入的 value 在 jsdom 里没法预先设成非空，所以直接记录组件对它的写入：
    // 少了这次清空，用户第二次挑同一个文件浏览器就不会再触发 change。
    const valueWrites: string[] = [];
    Object.defineProperty(imageInput(), 'value', {
      configurable: true,
      get: () => '',
      set: (v: string) => { valueWrites.push(String(v)); }
    });

    uploadHandler = async () => jsonResponse({ media: [media('image', 'md_a')], failed: [] });
    await selectFiles(imageInput(), [picked]);
    await flush();
    expect(valueWrites).toEqual(['']);

    uploadHandler = async () => jsonResponse({ media: [media('image', 'md_b')], failed: [] });
    await selectFiles(imageInput(), [picked]);
    await flush();

    expect(valueWrites).toEqual(['', '']);
    expect(uploadForms).toHaveLength(2);
    expect(attachmentItems()).toHaveLength(2);
  });

  it('字段名按文件类型推断：图片永远走 image，非图片才走 file', async () => {
    await render();

    await selectFiles(imageInput(), [file('cat.png', 'image/png')]);
    await flush();
    expect([...uploadForms[0]!.keys()]).toEqual(['image']);

    // 从「发送文件」入口选的图片也要按 image 上传，否则服务端不会生成缩略图。
    uploadHandler = async () => jsonResponse({ media: [media('image', 'md_b')], failed: [] });
    await selectFiles(fileInput(), [file('dog.png', 'image/png')]);
    await flush();
    expect([...uploadForms[1]!.keys()]).toEqual(['image']);

    uploadHandler = async () => jsonResponse({ media: [media('file', 'md_c')], failed: [] });
    await selectFiles(fileInput(), [file('spec.pdf', 'application/pdf')]);
    await flush();
    expect([...uploadForms[2]!.keys()]).toEqual(['file']);
  });

  it('部分文件失败时提示数量与首条原因，成功的那些照样进附件条', async () => {
    uploadHandler = async () =>
      jsonResponse({
        media: [media('image', 'md_ok')],
        failed: [
          { filename: 'huge.png', error: '文件太大' },
          { filename: 'weird.tiff', error: '格式不支持' }
        ]
      });
    await render();

    await selectFiles(imageInput(), [file('huge.png', 'image/png'), file('cat.png', 'image/png')]);
    await flush();

    expect(onNotice).toHaveBeenCalledWith('2 个文件未能上传：文件太大');
    expect(attachmentItems()).toHaveLength(1);
    expect(hint()).toBeNull();
  });

  it('上传整体失败时提示原因，不产生附件条且上传态复位', async () => {
    uploadHandler = async () => jsonResponse({ message: '存储不可用' }, 503);
    await render();

    await selectFiles(imageInput(), [file('cat.png', 'image/png')]);
    await flush();

    expect(onNotice).toHaveBeenCalledWith('上传失败：存储不可用');
    expect(strip()).toBeNull();
    expect(hint()).toBeNull();
  });
});

describe('Composer 附件发送', () => {
  it('只有附件没有文本也能发送，成功后附件条清空', async () => {
    await render();
    expect(sendBtn().disabled).toBe(true);

    await selectFiles(imageInput(), [file('cat.png', 'image/png')]);
    await flush();
    expect(sendBtn().disabled).toBe(false);

    await click(sendBtn());
    await flush();

    expect(sentContents()).toEqual([[{ type: 'image', mediaId: 'md_up' }]]);
    expect(strip()).toBeNull();
  });

  it('文本在前，附件按加入顺序在后', async () => {
    await render();

    uploadHandler = async () => jsonResponse({ media: [media('image', 'md_1')], failed: [] });
    await selectFiles(imageInput(), [file('cat.png', 'image/png')]);
    await flush();

    uploadHandler = async () => jsonResponse({ media: [media('file', 'md_2')], failed: [] });
    await selectFiles(fileInput(), [file('spec.pdf', 'application/pdf')]);
    await flush();

    await type('看这两个');
    await click(sendBtn());
    await flush();

    expect(sentContents()).toEqual([
      [
        { type: 'text', text: '看这两个' },
        { type: 'image', mediaId: 'md_1' },
        { type: 'file', mediaId: 'md_2' }
      ]
    ]);
    expect(input().value).toBe('');
  });

  it('三种 kind 各自映射到对应内容块，语音带上时长与转写', async () => {
    uploadHandler = async () =>
      jsonResponse({
        media: [
          media('image', 'md_i'),
          media('audio', 'md_v', { duration: 3.2, transcript: '你在吗' }),
          media('file', 'md_f')
        ],
        failed: []
      });
    await render();

    await selectFiles(fileInput(), [file('mixed.bin', 'application/octet-stream')]);
    await flush();
    expect(attachmentItems()).toHaveLength(3);

    await click(sendBtn());
    await flush();

    expect(sentContents()).toEqual([
      [
        { type: 'image', mediaId: 'md_i' },
        { type: 'audio', mediaId: 'md_v', duration: 3.2, transcript: '你在吗' },
        { type: 'file', mediaId: 'md_f' }
      ]
    ]);
  });

  it('发送失败时附件和草稿都保留，可以原样重发', async () => {
    const pending = deferredSend();
    onSend.mockImplementation(() => pending.promise);
    await render();

    await selectFiles(imageInput(), [file('cat.png', 'image/png')]);
    await flush();
    await type('带图的话');

    await click(sendBtn());
    await act(async () => {
      pending.fail(new Error('offline'));
      await Promise.resolve();
    });

    expect(input().value).toBe('带图的话');
    expect(attachmentItems()).toHaveLength(1);
    expect(sendBtn().disabled).toBe(false);

    onSend.mockImplementation(async () => ({}));
    await click(sendBtn());
    await flush();

    expect(sentContents()).toEqual([
      [{ type: 'text', text: '带图的话' }, { type: 'image', mediaId: 'md_up' }],
      [{ type: 'text', text: '带图的话' }, { type: 'image', mediaId: 'md_up' }]
    ]);
    expect(strip()).toBeNull();
  });
});

describe('Composer 移除附件', () => {
  it('移除按钮只删掉自己那一条', async () => {
    uploadHandler = async () =>
      jsonResponse({ media: [media('file', 'md_1', { name: '一.pdf' }), media('file', 'md_2', { name: '二.pdf' })], failed: [] });
    await render();

    await selectFiles(fileInput(), [file('spec.pdf', 'application/pdf')]);
    await flush();
    expect(attachmentItems()).toHaveLength(2);

    await click(removeBtns()[0]!);
    expect(attachmentItems()).toHaveLength(1);
    expect(strip()!.textContent).toContain('二.pdf');
    expect(strip()!.textContent).not.toContain('一.pdf');
  });

  it('删到没有附件时整块附件条消失，没有文本就回到禁用', async () => {
    await render();

    await selectFiles(imageInput(), [file('cat.png', 'image/png')]);
    await flush();
    expect(sendBtn().disabled).toBe(false);

    await click(removeBtns()[0]!);

    expect(strip()).toBeNull();
    expect(sendBtn().disabled).toBe(true);
  });
});

describe('Composer 附件 kind 归一', () => {
  it('sticker 类型的上传结果按图片渲染，并以 image 内容块发送', async () => {
    uploadHandler = async () => jsonResponse({ media: [media('sticker', 'md_s', { name: '贴纸.png' })], failed: [] });
    await render({ stickers: [] });

    await selectFiles(imageInput(), [file('sticker.png', 'image/png')]);
    await flush();
    // 附件条渲染出来后 `AuthenticatedImage` 才开始下载媒体，再放一轮才能看到 <img>。
    await flush();

    const item = attachmentItems()[0]!;
    expect(item.querySelector('.attachment-generic')).toBeNull();
    expect(item.querySelector('img')?.getAttribute('alt')).toBe('贴纸.png');

    await click(sendBtn());
    await flush();
    expect(sentContents()).toEqual([[{ type: 'image', mediaId: 'md_s' }]]);
  });
});

describe('Composer 拖放', () => {
  it('dragover 给编辑区加上 dragging 高亮，dragleave 取消', async () => {
    await render();
    expect(composer().classList.contains('dragging')).toBe(false);

    await drag('dragover');
    expect(composer().classList.contains('dragging')).toBe(true);

    await drag('dragleave');
    expect(composer().classList.contains('dragging')).toBe(false);
  });

  it('drop 结束拖放态，文件按 file 字段上传并进附件条', async () => {
    uploadHandler = async () => jsonResponse({ media: [media('file', 'md_d', { name: '拖来的.pdf' })], failed: [] });
    await render();

    await drag('dragover');
    await drag('drop', [file('spec.pdf', 'application/pdf')]);

    // 松手那一刻高亮就要消失，不能等上传完成。
    expect(composer().classList.contains('dragging')).toBe(false);
    expect(uploadForms).toHaveLength(1);
    expect([...uploadForms[0]!.keys()]).toEqual(['file']);

    await flush();
    expect(attachmentItems()).toHaveLength(1);
    expect(strip()!.textContent).toContain('拖来的.pdf');
  });

  it('拖进来的图片仍按 image 字段上传 —— 否则服务端不生成缩略图', async () => {
    uploadHandler = async () =>
      jsonResponse({ media: [media('image', 'md_i'), media('file', 'md_f')], failed: [] });
    await render();

    await drag('drop', [file('cat.png', 'image/png'), file('spec.pdf', 'application/pdf')]);

    expect(uploadForms).toHaveLength(1);
    expect([...uploadForms[0]!.keys()]).toEqual(['image', 'file']);
  });

  it('不带文件的 drop（比如拖拽选中文字）不发上传请求', async () => {
    await render();

    await drag('dragover');
    await drag('drop', []);
    await flush();

    expect(uploadForms).toHaveLength(0);
    expect(composer().classList.contains('dragging')).toBe(false);
    expect(hint()).toBeNull();
    expect(strip()).toBeNull();
  });
});

describe('Composer 粘贴', () => {
  it('粘贴文件按 image 字段上传并拦截默认行为，字符串项被跳过', async () => {
    uploadHandler = async () => jsonResponse({ media: [media('image', 'md_p')], failed: [] });
    await render();

    // 真实剪贴板里截图通常同时带一个 text/html 字符串项，只有文件项该被收下。
    const evt = await paste([
      { kind: 'string' },
      { kind: 'file', file: file('shot.png', 'image/png') }
    ]);

    expect(evt.defaultPrevented).toBe(true);
    expect(uploadForms).toHaveLength(1);
    expect([...uploadForms[0]!.keys()]).toEqual(['image']);

    await flush();
    expect(attachmentItems()).toHaveLength(1);
  });

  it('粘贴的非图片文件也按 image 字段兜底上传 —— 图片按类型推断，这里锁的是参数本身', async () => {
    uploadHandler = async () => jsonResponse({ media: [media('file', 'md_pf')], failed: [] });
    await render();

    const evt = await paste([{ kind: 'file', file: file('doc.pdf', 'application/pdf') }]);

    expect(evt.defaultPrevented).toBe(true);
    expect(uploadForms).toHaveLength(1);
    expect([...uploadForms[0]!.keys()]).toEqual(['image']);
  });

  it('纯文本粘贴不上传也不 preventDefault —— 否则粘贴文字直接失效', async () => {
    await render();

    const evt = await paste([{ kind: 'string' }]);

    expect(evt.defaultPrevented).toBe(false);
    expect(uploadForms).toHaveLength(0);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('file 项拿不到文件（getAsFile 为 null）时同样不拦截、不上传', async () => {
    await render();

    const evt = await paste([{ kind: 'file', file: null }]);

    expect(evt.defaultPrevented).toBe(false);
    expect(uploadForms).toHaveLength(0);
  });
});

describe('Composer 语音分支', () => {
  it('点击语音后切换到录音态，取消后恢复编辑区', async () => {
    await render();
    expect(composerRow()).not.toBeNull();
    expect(recorder()).toBeNull();

    await click(voiceBtn());
    expect(composerRow()).toBeNull();
    expect(recorder()).not.toBeNull();

    await click(voiceCancelBtn());
    expect(recorder()).toBeNull();
    expect(composerRow()).not.toBeNull();
  });

  it('录音完成后追加 audio 附件，并按时长与转写发送', async () => {
    await render();
    await click(voiceBtn());
    await click(voiceReadyBtn());

    expect(recorder()).toBeNull();
    expect(composerRow()).not.toBeNull();
    expect(attachmentItems()).toHaveLength(1);
    expect(attachmentItems()[0]!.textContent).toContain('5s');

    await click(sendBtn());
    await flush();

    expect(sentContents()).toEqual([
      [{ type: 'audio', mediaId: 'md_voice', duration: 4.6, transcript: 'voice text' }]
    ]);
    expect(strip()).toBeNull();
  });
});
