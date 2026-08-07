// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DecisionTracePage from './DecisionTracePage.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const TRACE = {
  batchId: 'b1',
  revision: 3,
  replyIntent: 'emotional_support',
  lifeContext: ['location: cafe', 'weather: rain'],
  weather: 'rain 18°C',
  memoryRecallCount: 2,
  voiceMode: null,
  semanticGuard: 'pass',
  experimentVariant: null,
  proactive: null,
  createdAt: '2026-08-07T10:00:00Z'
};

const RECENT = { traces: [TRACE, { ...TRACE, batchId: 'b2', revision: 1, semanticGuard: 'fallback', createdAt: '2026-08-07T09:00:00Z' }] };

function routeFetch(handler: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => { created.render(<DecisionTracePage />); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DecisionTracePage', () => {
  it('renders the timeline and the selected trace detail with collapsible raw JSON', async () => {
    routeFetch((url) => {
      if (url.startsWith('/api/admin/decision-trace/recent')) return json(RECENT);
      if (url.startsWith('/api/admin/decision-trace?batchId=')) {
        const batchId = new URL(url, 'http://x').searchParams.get('batchId');
        return json({ trace: { ...TRACE, batchId: batchId ?? TRACE.batchId } });
      }
      return json({ message: 'not found' }, 404);
    });
    await render();
    expect(container!.querySelector('[data-testid="decision-trace-page"]')).not.toBeNull();
    const items = container!.querySelectorAll('.trace-item');
    expect(items.length).toBe(2);
    expect(container!.querySelector('[data-testid="trace-detail"]')?.textContent).toContain('b1');
    expect(container!.querySelector('[data-testid="trace-detail"]')?.textContent).toContain('emotional_support');
    expect(container!.querySelector('[data-testid="trace-detail"]')?.textContent).toContain('2 条');
    // Raw JSON is collapsed inside a <details>.
    const details = container!.querySelector<HTMLDetailsElement>('[data-testid="trace-json-section"]')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('pre.shadow-code')?.textContent).toContain('"batchId"');
    // Switching selection fetches the exact batch revision.
    await act(async () => { (items[1] as HTMLButtonElement).click(); });
    expect(container!.querySelector('[data-testid="trace-detail"]')?.textContent).toContain('b2');
  });

  it('shows the empty state and the unauthorized state', async () => {
    routeFetch((url) => url.startsWith('/api/admin/decision-trace/recent') ? json({ traces: [] }) : json({ message: 'no' }));
    await render();
    expect(container!.textContent).toContain('暂无决策记录');
    await act(async () => { root!.unmount(); root = null; container!.remove(); container = null; });
    routeFetch((url) => url.startsWith('/api/admin/decision-trace/recent') ? json({ message: 'missing token' }, 401) : json({ message: 'no' }));
    await render();
    const state = container!.querySelector('.admin-state-unauthorized');
    expect(state).not.toBeNull();
  });

  it('shows the flag-disabled state when the API reports it disabled', async () => {
    routeFetch((url) => url.startsWith('/api/admin/decision-trace/recent')
      ? json({ message: 'ADMIN_DECISION_TRACE_ENABLED 未启用' }, 400)
      : json({ message: 'no' }));
    await render();
    const state = container!.querySelector('.admin-state-flag-disabled');
    expect(state).not.toBeNull();
  });
});
