// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageItem } from './MessageItem.js';
import type { ChatMessage } from '../lib/types.js';
import { clearMediaCache } from '../lib/authenticatedMedia.js';

/**
 * Every assistant reply is stored with `replyTo` pointing at the message that
 * triggered it — that link is structural and the server needs it. The UI, however,
 * used to render a quote of it unconditionally, so in a 1v1 chat every single bot
 * message repeated the line directly above it: the user read that as the bot
 * prefixing their own words onto its replies.
 */

function message(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    conversationId: 'c1',
    role: 'assistant',
    createdAt: '2026-07-30T12:00:00.000Z',
    updatedAt: '2026-07-30T12:00:00.000Z',
    seq: 1,
    status: 'sent',
    replyTo: null,
    content: [{ id: `${overrides.id}-p1`, type: 'text', text: '回复内容' }],
    ...overrides
  } as ChatMessage;
}

let root: Root | null = null;
let container: HTMLElement;

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => { created.render(node); });
}

const preview = () => container.querySelector('[data-testid="reply-preview"]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  container?.remove();
  clearMediaCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const common = {
  personaName: 'SOOYA',
  avatar: '/avatars/sooya.svg',
  userAvatar: '/avatars/user.svg',
  showAvatar: true
};

describe('MessageItem 引用块', () => {
  it('引用的就是上一条时不显示 —— 1v1 里那是重复', async () => {
    const user = message({ id: 'm1', role: 'user' });
    const reply = message({ id: 'm2', replyTo: 'm1' });

    await render(<MessageItem {...common} message={reply} quoted={user} quotedLabel="我" previousId="m1" />);

    expect(preview()).toBeNull();
    expect(container.textContent).toContain('回复内容');
  });

  it('引用更早的消息时照常显示', async () => {
    const older = message({ id: 'm1', role: 'user', content: [{ id: 'p', type: 'text', text: '很久以前说的话' }] } as never);
    const reply = message({ id: 'm9', replyTo: 'm1' });

    await render(<MessageItem {...common} message={reply} quoted={older} quotedLabel="我" previousId="m8" />);

    expect(preview()).not.toBeNull();
    expect(preview()?.textContent).toContain('我');
    expect(preview()?.textContent).toContain('很久以前说的话');
  });

  it('没有上一条（会话第一条）也按重复处理不了，仍然显示', async () => {
    const older = message({ id: 'm1', role: 'user' });
    const reply = message({ id: 'm2', replyTo: 'm1' });

    await render(<MessageItem {...common} message={reply} quoted={older} quotedLabel="我" previousId={null} />);

    expect(preview()).not.toBeNull();
  });

  it('用户主动引用的消息已不在记录里时给出说明', async () => {
    // A quote the user chose deliberately: dropping it silently would lose the fact
    // that this message was a reply at all.
    const mine = message({ id: 'm2', role: 'user', replyTo: 'gone' });

    await render(<MessageItem {...common} message={mine} quoted={null} quotedLabel="" previousId="m1" />);

    expect(preview()?.textContent).toContain('原消息已删除或不可用');
  });

  it('bot 回复指向的消息已滚出窗口时什么都不显示', async () => {
    // Every assistant turn carries replyTo for stream recovery, so this placeholder
    // was appearing on the first bubble of the loaded window on every single load —
    // information the user cannot act on, attached to a reply nobody made.
    const reply = message({ id: 'm2', replyTo: 'gone' });

    await render(<MessageItem {...common} message={reply} quoted={null} quotedLabel="" previousId="m1" />);

    expect(preview()).toBeNull();
    expect(container.textContent).not.toContain('原消息已不在当前记录中');
  });

  it('用户自己引用上一条 bot 消息时仍显示主动引用', async () => {
    const bot = message({ id: 'm1' });
    const mine = message({ id: 'm2', role: 'user', replyTo: 'm1' });

    await render(<MessageItem {...common} message={mine} quoted={bot} quotedLabel="SOOYA" previousId="m1" />);

    expect(preview()).not.toBeNull();
  });
});

describe('MessageItem 重放操作', () => {
  it('不为失败的助手消息或历史音频显示重试入口', async () => {
    await render(<MessageItem {...common} message={message({ id: 'a1', status: 'failed' })} onRetry={() => {}} />);
    expect(container.querySelector('.retry-btn')).toBeNull();

    await act(async () => { root!.unmount(); });
    root = null;
    container.remove();
    await render(<MessageItem {...common} message={message({
      id: 'u1', role: 'user', status: 'failed',
      content: [{ id: 'audio', type: 'audio', mediaId: 'md_audio', status: 'sent' }]
    })} onRetry={() => {}} />);
    expect(container.querySelector('.retry-btn')).toBeNull();
  });
});

describe('MessageItem 搜索高亮', () => {
  it('只高亮搜索词，不把用户文本当 HTML 注入', async () => {
    await render(<MessageItem {...common} message={message({ id: 'm_search', role: 'user', content: [{ id: 'p', type: 'text', text: '北京 <script>alert(1)</script>' }] } as never)} highlightQuery="北京" />);
    expect(container.querySelector('mark')?.textContent).toBe('北京');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});

function imageMessage(width?: number | null, height?: number | null): ChatMessage {
  return message({
    id: 'm_image',
    content: [{
      id: 'p_image',
      type: 'image',
      status: 'sent',
      mediaId: 'media_1',
      media: {
        id: 'media_1',
        kind: 'image',
        mime: 'image/png',
        bytes: 123,
        width,
        height,
        url: '/api/media/media_1',
        name: '照片.png'
      }
    }]
  });
}

describe('MessageItem 图片占位', () => {
  it('下载完成前预留真实比例且禁止打开，完成后不改变盒子几何', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image-ready');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const open = vi.fn();

    await render(<MessageItem {...common} showAvatar={false} message={imageMessage(800, 1200)} onOpenImage={open} />);
    const button = container.querySelector<HTMLButtonElement>('.image-part')!;

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(Number.parseFloat(button.style.aspectRatio)).toBeCloseTo(800 / 1200);
    expect(button.style.width).toBe('213px');
    expect(button.querySelector('.image-part-placeholder')).not.toBeNull();
    button.click();
    expect(open).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetch(new Response(new Blob(['image'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(Number.parseFloat(button.style.aspectRatio)).toBeCloseTo(800 / 1200);
    expect(button.style.width).toBe('213px');
    expect(button.querySelector('img')?.getAttribute('src')).toBe('blob:image-ready');
    expect(button.querySelector('.image-part-placeholder')).toBeNull();
  });

  it('缺失或非法尺寸元数据时使用 4:3 默认占位', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:default-ratio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    await render(<MessageItem {...common} showAvatar={false} message={imageMessage(null, 0)} />);

    const button = container.querySelector<HTMLElement>('.image-part')!;
    expect(Number.parseFloat(button.style.aspectRatio)).toBeCloseTo(4 / 3);
    expect(button.style.width).toBe('260px');
  });
});
