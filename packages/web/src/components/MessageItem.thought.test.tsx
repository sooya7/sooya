// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageItem } from './MessageItem.js';
import type { ChatMessage } from '../lib/types.js';
import { clearMediaCache } from '../lib/authenticatedMedia.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement;

interface Call { url: string; }

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

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => { created.render(node); });
}

function stubThought(urlPrefix: string, body: unknown, status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    if (url.startsWith(urlPrefix)) {
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const common = {
  personaName: 'SOOYA',
  avatar: '/avatars/sooya.svg',
  userAvatar: '/avatars/user.svg',
  showAvatar: true
};

const THOUGHT = {
  thought: {
    id: 't1',
    messageId: 'm1',
    batchId: 'b1',
    revision: 1,
    kind: 'inner_monologue',
    text: '她在想：天气真好。要不要约他出去走走？还是先看看他忙不忙吧。第四句不该出现。',
    visibility: 'user',
    status: 'completed',
    createdAt: '2026-07-30T12:00:00.000Z'
  }
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  container?.remove();
  clearMediaCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { localStorage.removeItem('sooya.inner-thought-mode'); } catch { /* ignore */ }
});

describe('InnerThoughtChip in MessageItem', () => {
  it('ignores the removed legacy mode preference and always starts collapsed', async () => {
    try { localStorage.setItem('sooya.inner-thought-mode', 'immersive'); } catch { /* ignore */ }
    const calls = stubThought('/api/thoughts/', THOUGHT);
    await render(<MessageItem {...common} message={message({ id: 'm1' })} />);

    expect(calls.some((c) => c.url === '/api/thoughts/m1')).toBe(true);
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="inner-thought"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('她在想');
    expect(chip?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('天气真好');
    expect(localStorage.getItem('sooya.inner-thought-mode')).toBeNull();
  });

  it('expands inline on tap and keeps the normal reply bubble intact', async () => {
    const calls = stubThought('/api/thoughts/', THOUGHT);
    await render(<MessageItem {...common} message={message({ id: 'm1' })} />);
    expect(calls.some((c) => c.url === '/api/thoughts/m1')).toBe(true);

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="inner-thought"]');
    await act(async () => { chip!.click(); });
    const expanded = container.querySelector('[data-testid="inner-thought"]')!;
    expect(expanded.textContent).toContain('天气真好');
    expect(expanded.textContent).not.toContain('第四句');
    expect(container.querySelector('[data-testid="text-bubble"]')?.textContent).toContain('回复内容');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('stays silent when no thought exists (404)', async () => {
    stubThought('/api/thoughts/', { message: 'not found' }, 404);
    await render(<MessageItem {...common} message={message({ id: 'm1' })} />);
    expect(container.querySelector('[data-testid="inner-thought"]')).toBeNull();
  });

  it('never attaches to user messages or failed messages', async () => {
    stubThought('/api/thoughts/', THOUGHT);
    await render(<>
      <MessageItem {...common} message={message({ id: 'u1', role: 'user' })} />
      <MessageItem {...common} message={message({ id: 'f1', status: 'failed' })} />
    </>);
    expect(container.querySelectorAll('[data-testid="inner-thought"]').length).toBe(0);
  });
});
