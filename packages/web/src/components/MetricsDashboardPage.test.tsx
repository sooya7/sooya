// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MetricsDashboardPage from './MetricsDashboardPage.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

interface Call { url: string; method: string | undefined; }

const AGGREGATES = {
  aggregates: [
    { category: 'reply', metric: 'reply_count', sum: 12, count: 4, avg: 3 },
    { category: 'reply', metric: 'reply_latency_ms', sum: 3000, count: 4, avg: 750 },
    { category: 'voice', metric: 'voice_seconds', sum: 60, count: 2, avg: 30 }
  ]
};

// Wire format matches the server route: `{ comparison: ReleaseMetricsComparison }`.
const COMPARE = {
  comparison: {
    current: { from: '2026-08-01', to: '2026-08-07', aggregates: AGGREGATES.aggregates },
    previous: { from: '2026-07-25', to: '2026-07-31', aggregates: [{ category: 'reply', metric: 'reply_count', sum: 6, count: 2, avg: 3 }] }
  }
};

const DISTRIBUTIONS = {
  distributions: [{ category: 'reply', metric: 'reply_latency_ms', count: 4, sum: 3000, min: 500, max: 1000, mean: 750, p50: 700, p95: 950 }]
};

function routeFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { url: String(input), method: init.method };
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
  await act(async () => { created.render(<MetricsDashboardPage />); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  try { localStorage.setItem('sooya.admin-token', 'test-token'); } catch { /* ignore */ }
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { localStorage.removeItem('sooya.admin-token'); } catch { /* ignore */ }
});

describe('MetricsDashboardPage', () => {
  it('renders loading, then categories with percentage-driven bars and touch range selector', async () => {
    routeFetch((call) => {
      if (call.url.startsWith('/api/admin/metrics?days=')) return json(AGGREGATES);
      if (call.url.startsWith('/api/admin/metrics/distributions')) return json(DISTRIBUTIONS);
      if (call.url.startsWith('/api/admin/metrics/release-compare')) return json(COMPARE);
      return json({ message: 'not found' }, 404);
    });
    await render();
    expect(container!.querySelector('[data-testid="metrics-page"]')).not.toBeNull();
    // Range selector: segmented buttons with aria-pressed.
    const rangeButtons = [...container!.querySelectorAll<HTMLButtonElement>('.range-seg button')];
    expect(rangeButtons.length).toBe(3);
    expect(rangeButtons[0]?.getAttribute('aria-pressed')).toBe('true');
    // Bars are relative % widths, never fixed px.
    const fill = container!.querySelector<HTMLElement>('.metric-bar > i');
    expect(fill?.style.width).toMatch(/%$/);
    // Category tables keep the .metrics-category table contract.
    expect(container!.querySelector('.metrics-category table')).not.toBeNull();
    // Release compare was removed in closure; distributions keep p50/p95.
    expect(container!.querySelector('[data-testid="metrics-compare"]')).toBeNull();
    expect(container!.textContent).not.toContain('差异');
    expect(container!.textContent).toContain('p50');
  });

  it('switching range re-fetches with the new days param', async () => {
    const calls = routeFetch((call) => {
      if (call.url.startsWith('/api/admin/metrics?days=')) return json(AGGREGATES);
      if (call.url.startsWith('/api/admin/metrics/distributions')) return json({ distributions: [] });
      if (call.url.startsWith('/api/admin/metrics/release-compare')) return json(COMPARE);
      return json({ message: 'not found' }, 404);
    });
    await render();
    const rangeButtons = [...container!.querySelectorAll<HTMLButtonElement>('.range-seg button')];
    await act(async () => { rangeButtons[1]!.click(); });
    expect(rangeButtons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(calls.some((c) => c.url.includes('days=30'))).toBe(true);
  });

  it('shows a flag-disabled/error state via adminStateFromError mapping', async () => {
    routeFetch(() => json({ message: 'METRICS_DASHBOARD_ENABLED 未启用' }, 400));
    await render();
    const state = container!.querySelector('.admin-state-flag-disabled');
    expect(state).not.toBeNull();
    expect(state!.textContent).toContain('METRICS_DASHBOARD_ENABLED');
  });
});
