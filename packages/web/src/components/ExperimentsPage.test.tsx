// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExperimentsPage from './ExperimentsPage.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

interface Call { url: string; method: string | undefined; body: unknown; }

const EXPERIMENTS = {
  experiments: [
    {
      id: 'e1',
      name: '连续性权重 1.5',
      subsystem: 'life.continuity_weight',
      variants_json: '["x1","x1.5"]',
      status: 'shadow',
      assignment_scope: 'day',
      created_at: '2026-08-01T00:00:00Z',
      updated_at: '2026-08-01T00:00:00Z',
      variants: ['x1', 'x1.5'],
      currentVariant: 'x1'
    }
  ]
};

const REPORT = {
  report: {
    experimentId: 'e1',
    name: '连续性权重 1.5',
    samples: 24,
    control: 12,
    treatment: 12,
    observedDifference: [{ metric: 'reply_count', control: 10, treatment: 11 }]
  }
};

const HISTORY = {
  history: [
    { id: 'h1', experimentId: 'e1', event: 'created', variant: '', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'h2', experimentId: 'e1', event: 'shadow', variant: 'x1.5', createdAt: '2026-08-02T00:00:00Z' }
  ]
};

function routeFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => { created.render(<ExperimentsPage />); });
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

describe('ExperimentsPage', () => {
  it('creates a draft and keeps lifecycle buttons grouped with a danger separator', async () => {
    const calls = routeFetch((call) => {
      if (call.url === '/api/admin/experiments' && call.method === 'POST') return json({ experiment: {} });
      if (call.url === '/api/admin/experiments') return json(EXPERIMENTS);
      return json({ message: 'not found' }, 404);
    });
    await render();
    // Danger ops (完成/取消) are visually separated from primary actions.
    const actions = container!.querySelector('td.data-list-actions')!;
    expect(actions.querySelectorAll('.danger-sep').length).toBeGreaterThan(0);
    expect(actions.querySelector('.admin-danger')).not.toBeNull();
    // Create form validates: needs a name and >= 2 variants.
    const createButton = [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '创建草稿')!;
    await act(async () => { createButton.click(); });
    expect(container!.querySelector('.admin-notice-error')?.textContent).toContain('至少 2 个');
    const nameInput = container!.querySelector<HTMLInputElement>('input[placeholder="例如：连续性权重 1.5"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(nameInput, '实验一');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { createButton.click(); });
    expect(calls.some((c) => c.url === '/api/admin/experiments' && c.method === 'POST')).toBe(true);
  });

  it('transitions to running only after confirmation and loads report/history on expand', async () => {
    const calls = routeFetch((call) => {
      if (call.url === '/api/admin/experiments' && call.method === 'PATCH') return json({ experiment: { ...EXPERIMENTS.experiments[0], status: 'running' } });
      if (call.url === '/api/admin/experiments') return json(EXPERIMENTS);
      if (call.url.endsWith('/report')) return json(REPORT);
      if (call.url.endsWith('/history')) return json(HISTORY);
      return json({ message: 'not found' }, 404);
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await render();
    const row = container!.querySelector('[data-testid="experiment-table"] tbody tr')!;
    const promote = [...row.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '正式运行')!;
    await act(async () => { promote.click(); });
    expect(window.confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes('/experiments/e1') && c.method === 'PATCH')).toBe(true);
    // Report/history are lazy: only fetched when the row expands.
    expect(calls.some((c) => c.url.endsWith('/report'))).toBe(false);
    const toggle = row.querySelector<HTMLButtonElement>('button.data-list-expand')!;
    await act(async () => { toggle.click(); });
    expect(calls.some((c) => c.url.endsWith('/report'))).toBe(true);
    expect(container!.querySelector('[data-testid="experiment-history-e1"]')?.textContent).toContain('进入 Shadow');
    confirmSpy.mockRestore();
  });

  it('aborts transition when confirmation is declined', async () => {
    const calls = routeFetch((call) => {
      if (call.url === '/api/admin/experiments' && call.method === 'PATCH') return json({ experiment: {} });
      if (call.url === '/api/admin/experiments') return json(EXPERIMENTS);
      return json({ message: 'not found' }, 404);
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await render();
    const row = container!.querySelector('[data-testid="experiment-table"] tbody tr')!;
    const promote = [...row.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '正式运行')!;
    await act(async () => { promote.click(); });
    expect(calls.some((c) => c.url.includes('/experiments/e1') && c.method === 'PATCH')).toBe(false);
    confirmSpy.mockRestore();
  });
});
