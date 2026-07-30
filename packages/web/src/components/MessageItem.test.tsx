// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageItem } from './MessageItem.js';
import type { ChatMessage } from '../lib/types.js';

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

  it('引用的消息已经不在记录里时给出说明', async () => {
    const reply = message({ id: 'm2', replyTo: 'gone' });

    await render(<MessageItem {...common} message={reply} quoted={null} quotedLabel="" previousId="m1" />);

    expect(preview()?.textContent).toContain('原消息已不在当前记录中');
  });

  it('用户自己引用上一条 bot 消息时同样不重复显示', async () => {
    const bot = message({ id: 'm1' });
    const mine = message({ id: 'm2', role: 'user', replyTo: 'm1' });

    await render(<MessageItem {...common} message={mine} quoted={bot} quotedLabel="SOOYA" previousId="m1" />);

    expect(preview()).toBeNull();
  });
});
