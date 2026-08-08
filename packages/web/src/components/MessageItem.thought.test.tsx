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
  try { localStorage.setItem('sooya.inner-thought-mode', 'brief'); } catch { /* ignore */ }
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
  it('does not render or fetch in off mode', async () => {
    try { localStorage.setItem('sooya.inner-thought-mode', 'off'); } catch { /* ignore */ }
    const calls = stubThought('/api/thoughts/', THOUGHT);
    await render(<MessageItem {...common} message={message({ id: 'm1' })} />);
    expect(container.querySelector('[data-testid="inner-thought"]')).toBeNull();
    expect(calls.some((c) => c.url.startsWith('/api/thoughts/'))).toBe(false);
    expect(container.textContent).toContain('回复内容');
  });

  it('renders a collapsed chip in brief mode and expands inline (no popup)', async () => {
    const calls = stubThought('/api/thoughts/', THOUGHT);
    await render(<MessageItem {...common} message={message({ id: 'm1' })} />);
    expect(calls.some((c) => c.url === '/api/thoughts/m1')).toBe(true);
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="inner-thought"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('她在想');
    expect(chip?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { chip!.click(); });
    const expanded = container.querySelector('[data-testid="inner-thought"]')!;
    expect(expanded.textContent).toContain('天气真好');
    // Truncated to 3 sentences: the fourth is dropped.
    expect(expanded.textContent).not.toContain('第四句');
    // Bubbles remain intact next to the thought block.
    expect(container.querySelector('[data-testid="text-bubble"]')?.textContent).toContain('回复内容');
    // Inline expansion only: no dialog/sheet is ever rendered.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the thought expanded by default in immersive mode', async () => {
    try { localStorage.setItem('sooya.inner-thought-mode', 'immersive'); } catch { /* ignore */ }
    stubThought('/api/thoughts/', THOUGHT);
    await render(<MessageItem {...common} message={message({ id: 'm1' })} />);
    const block = container.querySelector('[data-testid="inner-thought"]')!;
    expect(block.textContent).toContain('天气真好');
    expect(block.textContent).not.toContain('第四句');
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

  it('cycles the mode from the chip and persists the choice', async () => {
    stubThought('/api/thoughts/', THOUGHT);
    await render(<MessageItem {...common} message={message({ id: 'm1' })} />);
    await act(async () => { (container.querySelector('[data-testid="inner-thought"]') as HTMLButtonElement).click(); });
    const modeButton = container.querySelector<HTMLButtonElement>('.thought-mode-btn')!;
    expect(modeButton.textContent).toBe('简短');
    await act(async () => { modeButton.click(); });
    expect(container.querySelector<HTMLButtonElement>('.thought-mode-btn')?.textContent).toBe('沉浸');
    expect(localStorage.getItem('sooya.inner-thought-mode')).toBe('immersive');
    await act(async () => { (container.querySelector('.thought-mode-btn') as HTMLButtonElement).click(); });
    // brief -> immersive -> off: chip unmounts entirely.
    expect(container.querySelector('[data-testid="inner-thought"]')).toBeNull();
    expect(localStorage.getItem('sooya.inner-thought-mode')).toBe('off');
  });
});
