// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShadowRunsPage from './ShadowRunsPage.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const RUNS = {
  runs: [
    {
      id: 'r1',
      subsystem: 'life.activity_selector',
      canonical_version: 'v1',
      shadow_version: 'v2',
      input_fingerprint: 'f1',
      canonical_decision: JSON.stringify({ activity: 'reading', confidence: 0.8 }),
      shadow_decision: JSON.stringify({ activity: 'walking', confidence: 0.6 }),
      diff_json: JSON.stringify({ equal: false, changes: ['activity'] }),
      duration_ms: 12,
      created_at: '2026-08-07T10:00:00Z'
    },
    {
      id: 'r2',
      subsystem: 'life.location_selector',
      canonical_version: 'v1',
      shadow_version: 'v2',
      input_fingerprint: 'f2',
      canonical_decision: '{"place":"home"}',
      shadow_decision: '{"place":"home"}',
      diff_json: '{"equal":true}',
      duration_ms: 9,
      created_at: '2026-08-07T11:00:00Z'
    }
  ]
};

function routeFetch(handler: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => { created.render(<ShadowRunsPage />); });
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

describe('ShadowRunsPage', () => {
  it('shows stats and lists runs with a per-run expandable diff', async () => {
    routeFetch((url) => url.startsWith('/api/admin/shadow-runs') ? json(RUNS) : json({ message: 'no' }));
    await render();
    expect(container!.querySelector('[data-testid="shadow-run-count"]')?.textContent).toContain('2 次采样');
    const table = container!.querySelector('[data-testid="shadow-run-table"]')!;
    expect(table.textContent).toContain('生活活动选择');
    // Expanded row renders canonical + shadow side by side (stacked on mobile via CSS).
    const toggles = [...table.querySelectorAll<HTMLButtonElement>('button.data-list-expand')];
    expect(toggles.length).toBe(2);
    await act(async () => { toggles[0]!.click(); });
    const diff = container!.querySelector('[data-testid="run-diff-r1"]')!;
    expect(diff.querySelector('.shadow-diff-grid')).not.toBeNull();
    expect(diff.querySelectorAll('.shadow-diff-col').length).toBe(2);
    expect(diff.querySelector('.shadow-code')?.textContent).toContain('reading');
    // Diff detail appears only when the run differs.
    expect(container!.querySelector('[data-testid="run-diff-detail-r1"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="run-diff-detail-r2"]')).toBeNull();
  });

  it('renders the empty state when there are no runs', async () => {
    routeFetch((url) => url.startsWith('/api/admin/shadow-runs') ? json({ runs: [] }) : json({ message: 'no' }));
    await render();
    expect(container!.querySelector('[data-testid="shadow-run-count"]')?.textContent).toContain('0 次采样');
    expect(container!.textContent).toContain('暂无采样');
  });

  it('surfaces a load error as a notice', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'shadow disabled' }), { status: 400, headers: { 'content-type': 'application/json' } })));
    await render();
    expect(container!.querySelector('.admin-notice-error')?.textContent).toContain('shadow disabled');
  });
});
