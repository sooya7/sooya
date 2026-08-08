// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchAuthenticatedMedia = vi.fn();
vi.mock('../lib/authenticatedMedia.js', () => ({
  fetchAuthenticatedMedia: (...args: unknown[]) => fetchAuthenticatedMedia(...args),
  releaseMediaUrl: vi.fn(),
  safeDownloadName: (name: string) => name,
  blobForMediaUrl: () => null
}));
vi.mock('../lib/api.js', () => ({ getToken: () => 'tok', api: { visibleThought: async () => ({ thought: null }) } }));

import { MessageItem } from './MessageItem.js';
import type { ChatMessage } from '../lib/types.js';

/**
 * 文件气泡的下载是 `void savePart(part)`：fetchAuthenticatedMedia 一旦失败（媒体被清
 * 理、令牌过期、网络断开），Promise 悄悄 reject，气泡看起来就跟没点过一样 —— 用户
 * 只会反复点，永远不会知道是失败了。失败必须像图片加载失败那样看得见。
 */

function fileMessage(): ChatMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:00:00.000Z',
    seq: 1,
    status: 'sent',
    replyTo: null,
    content: [{
      id: 'p1',
      type: 'file',
      status: 'sent',
      media: { id: 'f1', kind: 'file', mime: 'application/pdf', bytes: 2048, url: '/api/media/f1', name: '报告.pdf' }
    }]
  } as ChatMessage;
}

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  container.remove();
});

async function mount(message = fileMessage()): Promise<void> {
  await act(async () => {
    root!.render(<MessageItem message={message} personaName="SOOYA" avatar="/avatars/sooya.svg" userAvatar="/avatars/user.svg" showAvatar={false} />);
  });
}

describe('FilePart 下载反馈', () => {
  it('下载失败时在气泡旁给出可见错误，不再静默', async () => {
    fetchAuthenticatedMedia.mockRejectedValue(new Error('媒体内容读取失败'));
    await mount();

    const button = container.querySelector<HTMLButtonElement>('.bubble-file')!;
    await act(async () => { button.click(); });

    expect(container.textContent).toContain('媒体内容读取失败');
  });

  it('下载成功时不显示错误', async () => {
    fetchAuthenticatedMedia.mockResolvedValue({ url: 'blob:f1', blob: new Blob(['x']), contentType: 'application/pdf' });
    await mount();

    const button = container.querySelector<HTMLButtonElement>('.bubble-file')!;
    await act(async () => { button.click(); });

    expect(container.textContent).not.toContain('失败');
  });

  it.each([
    ['pending', '正在解析'],
    ['ready', '可读取'],
    ['unsupported', '仅保存'],
    ['failed', '解析失败']
  ] as const)('显示文件正文状态 %s', async (status, label) => {
    const current = fileMessage();
    current.content[0]!.media!.textStatus = status;
    await mount(current);
    expect(container.querySelector('[data-testid="file-text-status"]')?.textContent).toBe(label);
  });
});
