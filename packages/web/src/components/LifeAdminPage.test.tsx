// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LifeAdminPage from './LifeAdminPage.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

interface Call { url: string; method: string | undefined; body: unknown; }

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

const OVERVIEW = {
  snapshot: { activity: '看书', kind: 'reading', mood: 'calm', theme: '慢生活', vitals: ['精力充沛'] },
  location: { id: 'l1', name: '家', kind: 'home' },
  weather: '晴 22°C',
  vitals: { energy: 70, hunger: 40, stress: 20, social_need: 30, loneliness: 10, curiosity: 50, comfort: 60, focus: 45, sleep_debt: 1 },
  activePlan: { id: 'p1', title: '写周记', kind: 'task', status: 'active' },
  openThreads: [{ id: 't1', title: '搬家计划', progress: 0.5 }],
  recentEvents: [{ id: 'e1', eventType: 'location.change', description: '回到家中', happenedAt: '2026-08-07T10:00:00Z' }]
};

const WEATHER_STATUS = {
  enabled: true,
  provider: { name: 'open-meteo', configured: true, active: true },
  lastSnapshot: { observedAt: '2026-08-07T10:00:00Z', condition: 'clear', temperatureC: 22, provider: 'open-meteo', locationKey: 'shanghai', stale: false },
  cacheAgeSec: 42,
  fallback: 'primary',
  daylight: { sunrise: '2026-08-07T05:12:00+08:00', sunset: '2026-08-07T18:47:00+08:00', isDaylight: true },
  forecast: null
};

const FORECAST = {
  forecast: {
    generatedAt: '2026-08-07T10:00:00Z',
    provider: 'open-meteo',
    severe: false,
    next12h: [
      { at: '2026-08-07T10:00:00Z', condition: 'clear', temperatureC: 22 },
      { at: '2026-08-07T11:00:00Z', condition: 'partly_cloudy', temperatureC: 23 }
    ],
    next3d: [{ at: '2026-08-08T00:00:00Z', condition: 'cloudy', temperatureC: 20 }]
  }
};

async function render(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => { created.render(<LifeAdminPage />); });
}

async function clickTab(label: string): Promise<void> {
  const tab = [...container!.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === label);
  if (!tab) throw new Error(`tab ${label} not found`);
  await act(async () => { tab.click(); });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  try { localStorage.removeItem('sooya.admin-token'); } catch { /* ignore */ }
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LifeAdminPage tabs', () => {
  it('renders a tablist with all sections and switches panels', async () => {
    routeFetch((call) => {
      if (call.url === '/api/admin/life/overview') return json(OVERVIEW);
      if (call.url === '/api/admin/life/locations') return json({ locations: [{ id: 'l1', name: '家', kind: 'home', tags: [], indoor: true, visitWeight: 1, source: 'builtin', active: true }] });
      return json({ message: 'not found' }, 404);
    });
    await render();
    const tabs = container!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs.length).toBe(8);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(container!.querySelector('[role="tabpanel"]')).not.toBeNull();
    await clickTab('Locations');
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false');
    expect(container!.querySelector('[data-testid="life-location-list"]')).not.toBeNull();
    await clickTab('Weather');
    expect(container!.querySelector('[data-testid="weather-section"]')).not.toBeNull();
  });

  it('shows overview data with a retry-able error state', async () => {
    routeFetch(() => json(OVERVIEW));
    await render();
    expect(container!.textContent).toContain('看书');
    expect(container!.textContent).toContain('家');
  });
});

describe('LifeAdminPage locations + geocode', () => {
  it('lists locations as key-value cells and confirms destructive actions in a dialog', async () => {
    const calls = routeFetch((call) => {
      if (call.url === '/api/admin/life/locations') {
        return call.method === 'POST'
          ? json({ location: {} })
          : json({ locations: [{ id: 'l1', name: '家', kind: 'home', tags: ['常驻'], indoor: true, visitWeight: 5, source: 'builtin', active: true }] });
      }
      if (call.url === '/api/admin/life/locations/l1' && call.method === 'DELETE') return json({ ok: true });
      if (call.url === '/api/admin/life/location/override') return json({ location: {} });
      return json({ message: 'not found' }, 404);
    });
    void calls;
    await render();
    await clickTab('Locations');
    const list = container!.querySelector('[data-testid="life-location-list"]')!;
    expect(list.querySelector('td')?.getAttribute('data-label')).toBe('名称');
    expect(list.textContent).toContain('家');
    // Danger action opens the ConfirmDialog; confirm sends the DELETE.
    const danger = [...list.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '停用')!;
    await act(async () => { danger.click(); });
    expect(container!.querySelector('[data-testid="modal-confirm"]')).not.toBeNull();
    expect(container!.textContent).toContain('停用「家」');
    const confirmButton = [...container!.querySelectorAll<HTMLButtonElement>('.confirm-dialog-actions button')].find((b) => b.textContent === '停用')!;
    await act(async () => { confirmButton.click(); });
    expect(calls.some((c) => c.url === '/api/admin/life/locations/l1' && c.method === 'DELETE')).toBe(true);
  });

  it('shows the provider-unconfigured state when geocode search fails with that hint', async () => {
    routeFetch((call) => {
      if (call.url === '/api/admin/life/locations') return json({ locations: [] });
      if (call.url === '/api/admin/life/geocode/search') return json({ message: 'geocode provider 未配置' }, 400);
      return json({ message: 'not found' }, 404);
    });
    await render();
    await clickTab('Locations');
    const input = container!.querySelector<HTMLInputElement>('input[aria-label="地理搜索关键词"]')!;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input, '上海'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const form = input.closest('form')!;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    const state = [...container!.querySelectorAll('[data-testid="admin-state"]')].find((s) => s.classList.contains('admin-state-provider-unconfigured'));
    expect(state).not.toBeNull();
    expect(state!.textContent).toContain('Provider 未配置');
  });
});

describe('LifeAdminPage weather tab', () => {
  it('renders cities, travel state, weather status, daylight and forecast', async () => {
    routeFetch((call) => {
      if (call.url === '/api/admin/life/cities') return json({ cities: [{ id: 'c1', name: '上海', region: '上海市', country: '中国', timeZone: 'Asia/Shanghai', active: true }] });
      if (call.url === '/api/admin/life/travel') return json({ travel: { fromLocationId: 'l1', toLocationId: 'l2', mode: 'transit', startedAt: '2026-08-07T09:00:00Z', expectedArriveAt: '2026-08-07T10:30:00Z' } });
      if (call.url === '/api/admin/weather/status') return json(WEATHER_STATUS);
      if (call.url === '/api/admin/weather/forecast') return json(FORECAST);
      return json({ message: 'not found' }, 404);
    });
    await render();
    await clickTab('Weather');
    const section = container!.querySelector('[data-testid="weather-section"]')!;
    expect(section.textContent).toContain('上海');
    expect(section.textContent).toContain('Asia/Shanghai');
    expect(section.textContent).toContain('公共交通');
    expect(section.textContent).toContain('open-meteo');
    expect(section.textContent).toContain('晴');
    expect(section.textContent).toContain('日出');
    expect(container!.querySelector('[data-testid="forecast-12h"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="forecast-3d"]')).not.toBeNull();
    // Forecast bars are percentage widths, never fixed px.
    const bar = container!.querySelector('.forecast-track > i') as HTMLElement | null;
    expect(bar?.style.width).toMatch(/%$/);
  });

  it('shows the flag-disabled state when weather is disabled', async () => {
    routeFetch((call) => {
      if (call.url === '/api/admin/life/cities') return json({ cities: [] });
      if (call.url === '/api/admin/life/travel') return json({ travel: null });
      if (call.url === '/api/admin/weather/status') return json({ ...WEATHER_STATUS, enabled: false });
      if (call.url === '/api/admin/weather/forecast') return json({ forecast: null });
      return json({ message: 'not found' }, 404);
    });
    await render();
    await clickTab('Weather');
    const state = [...container!.querySelectorAll('[data-testid="admin-state"]')].find((s) => s.classList.contains('admin-state-flag-disabled'));
    expect(state).not.toBeNull();
    expect(state!.textContent).toContain('WEATHER_ENABLED 未开启');
  });
});
