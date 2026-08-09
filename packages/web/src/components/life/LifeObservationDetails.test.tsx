// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminLifeOverview } from '../../lib/admin.js';
import type { LifePanelData } from '../../lib/features.js';
import { LifeObservationDetails } from './LifeObservationDetails.js';
import { LifeObservationPanel } from './LifeObservationPanel.js';

const apiMocks = vi.hoisted(() => ({
  life: vi.fn(),
  lifeOverview: vi.fn(),
  lifeVitals: vi.fn(),
  lifeLocations: vi.fn(),
  lifeCities: vi.fn(),
  lifeTravel: vi.fn(),
  weatherStatus: vi.fn(),
  weatherForecast: vi.fn(),
  createLocation: vi.fn(),
  deleteLocation: vi.fn(),
  overrideLocation: vi.fn(),
  createCity: vi.fn(),
  updateCity: vi.fn(),
  weatherRefresh: vi.fn(),
  adjustVitals: vi.fn(),
  resetVitals: vi.fn()
}));

vi.mock('../../lib/features.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/features.js')>();
  return {
    ...original,
    featureApi: {
      ...original.featureApi,
      life: apiMocks.life
    }
  };
});

vi.mock('../../lib/admin.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/admin.js')>();
  return {
    ...original,
    adminApi: {
      ...original.adminApi,
      ...apiMocks
    }
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const data: LifePanelData = {
  snapshot: {
    activity: '在窗边看书',
    kind: 'reading',
    mood: '平静',
    startedAt: '2026-08-09T08:00:00.000Z',
    endsAt: '2026-08-09T09:00:00.000Z',
    recent: []
  },
  log: [
    {
      id: 'activity-old',
      activity: '吃过早餐',
      kind: 'meal',
      mood: '轻松',
      started_at: '2026-08-09T06:30:00.000Z',
      ended_at: '2026-08-09T07:00:00.000Z',
      shared: 0
    }
  ],
  plans: [],
  events: [
    {
      id: 'event-new',
      plan_id: null,
      log_id: null,
      event_type: 'activity_completed',
      activity: '整理书架',
      kind: 'chore',
      description: '把书架整理好了',
      mood_before: null,
      mood_after: '满足',
      happened_at: '2026-08-09T09:30:00.000Z',
      shareable: 1,
      shared_at: null,
      created_at: '2026-08-09T09:30:00.000Z'
    }
  ],
  proactive: [
    {
      id: 'proactive-middle',
      candidateId: 'candidate-1',
      candidateKind: 'reading',
      candidateActivity: '分享读书感想',
      status: 'sent',
      blockedReason: null,
      requestedMode: 'text',
      finalMode: 'text',
      fallbackReason: null,
      messageId: 'message-1',
      sendSuccess: true,
      userResponseMessageId: null,
      userRespondedAt: null,
      detail: {},
      createdAt: '2026-08-09T08:00:00.000Z',
      updatedAt: '2026-08-09T08:00:00.000Z'
    }
  ],
  reachOut: {
    reach: false,
    reason: 'quiet_gap_not_met',
    candidate: null,
    sharedLastDay: 1,
    lastUserAt: null,
    lastAssistantAt: null,
    enabledByDeployment: true
  },
  settings: {
    reachOut: true,
    quietGapMinutes: 90,
    maxReachOutsPerDay: 3,
    silentFrom: 23,
    silentTo: 7,
    tzOffsetMinutes: 480
  }
};

const overview: AdminLifeOverview = {
  snapshot: { activity: '在窗边看书', kind: 'reading', mood: '平静' },
  location: { id: 'home', name: '家', kind: 'home' },
  weather: '晴',
  vitals: null,
  activePlan: null,
  openThreads: [],
  recentEvents: []
};

const vitals = {
  energy: 72,
  hunger: 25,
  stress: 18,
  social_need: 35,
  loneliness: 12,
  curiosity: 81,
  comfort: 76,
  focus: 64,
  sleep_debt: 1.5
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function button(label: string): HTMLButtonElement {
  const found = Array.from(container!.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`找不到按钮：${label}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

async function renderDetails(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<LifeObservationDetails data={data} overview={overview} />);
  });
}

function setSuccessfulReads(): void {
  apiMocks.lifeVitals.mockResolvedValue({ vitals });
  apiMocks.life.mockResolvedValue(structuredClone(data));
  apiMocks.lifeOverview.mockResolvedValue(structuredClone(overview));
  apiMocks.lifeLocations.mockResolvedValue({
    locations: [{ id: 'home', name: '家', kind: 'home', tags: ['安静'], indoor: true, visitWeight: 1, source: 'builtin', active: true }]
  });
  apiMocks.lifeCities.mockResolvedValue({
    cities: [{ id: 'shanghai', name: '上海', region: '上海', country: '中国', timeZone: 'Asia/Shanghai', active: true }]
  });
  apiMocks.lifeTravel.mockResolvedValue({ travel: null });
  apiMocks.weatherStatus.mockResolvedValue({
    enabled: true,
    provider: { name: 'weather-provider', configured: true, active: true },
    lastSnapshot: {
      observedAt: '2026-08-09T09:00:00.000Z',
      condition: 'clear',
      temperatureC: 28,
      provider: 'weather-provider',
      locationKey: 'shanghai',
      stale: false
    },
    cacheAgeSec: 60,
    fallback: 'primary',
    daylight: null,
    forecast: null
  });
  apiMocks.weatherForecast.mockResolvedValue({
    forecast: {
      generatedAt: '2026-08-09T09:00:00.000Z',
      provider: 'weather-provider',
      next12h: [{ at: '2026-08-09T10:00:00.000Z', condition: 'clear', temperatureC: 29 }],
      next3d: [{ at: '2026-08-10T09:00:00.000Z', condition: 'partly_cloudy', temperatureC: 30 }],
      severe: false
    }
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  setSuccessfulReads();
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  container?.remove();
  container = null;
});

describe('LifeObservationDetails', () => {
  it('renders after the thread preview in the observation panel', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<LifeObservationPanel onNotice={vi.fn()} />);
    });

    const threads = container.querySelector('[data-testid="life-threads-preview"]');
    const details = container.querySelector('[data-testid="life-observation-details"]');
    expect(details).not.toBeNull();
    expect(threads?.nextElementSibling).toBe(details);
    expect(details?.textContent).toContain('身体与节律');
    expect(details?.textContent).toContain('地点与天气');
    expect(details?.textContent).toContain('生活记录');
  });

  it('keeps all detail APIs lazy and loads the environment section only once', async () => {
    await renderDetails();

    expect(apiMocks.lifeVitals).not.toHaveBeenCalled();
    expect(apiMocks.lifeLocations).not.toHaveBeenCalled();
    expect(apiMocks.lifeCities).not.toHaveBeenCalled();
    expect(apiMocks.lifeTravel).not.toHaveBeenCalled();
    expect(apiMocks.weatherStatus).not.toHaveBeenCalled();
    expect(apiMocks.weatherForecast).not.toHaveBeenCalled();

    const toggle = button('地点与天气');
    const panelId = toggle.getAttribute('aria-controls');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).not.toBeNull();
    expect(document.getElementById(panelId!)?.hidden).toBe(true);

    await click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(panelId!)?.hidden).toBe(false);
    expect(apiMocks.lifeLocations).toHaveBeenCalledTimes(1);
    expect(apiMocks.lifeCities).toHaveBeenCalledTimes(1);
    expect(apiMocks.lifeTravel).toHaveBeenCalledTimes(1);
    expect(apiMocks.weatherStatus).toHaveBeenCalledTimes(1);
    expect(apiMocks.weatherForecast).toHaveBeenCalledTimes(1);
    expect(apiMocks.lifeVitals).not.toHaveBeenCalled();
    expect(document.getElementById(panelId!)?.textContent).toContain('家');
    expect(document.getElementById(panelId!)?.textContent).toContain('晴');
    expect(document.getElementById(panelId!)?.textContent).not.toContain('未启用');

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(apiMocks.lifeLocations).toHaveBeenCalledTimes(1);
    expect(apiMocks.lifeCities).toHaveBeenCalledTimes(1);
    expect(apiMocks.lifeTravel).toHaveBeenCalledTimes(1);
    expect(apiMocks.weatherStatus).toHaveBeenCalledTimes(1);
    expect(apiMocks.weatherForecast).toHaveBeenCalledTimes(1);
  });

  it('keeps a vitals failure local and retries only that section', async () => {
    apiMocks.lifeVitals
      .mockRejectedValueOnce(new Error('身体数据暂时不可用'))
      .mockResolvedValueOnce({ vitals });
    await renderDetails();

    await click(button('身体与节律'));
    const alert = container!.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('身体数据暂时不可用');

    await click(button('生活记录'));
    expect(container!.textContent).toContain('把书架整理好了');
    expect(alert?.textContent).toContain('身体数据暂时不可用');

    await click(button('重试'));
    expect(apiMocks.lifeVitals).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain('精力');
    expect(container!.textContent).toContain('72');
    expect(apiMocks.lifeLocations).not.toHaveBeenCalled();
    expect(apiMocks.lifeCities).not.toHaveBeenCalled();
    expect(apiMocks.lifeTravel).not.toHaveBeenCalled();
    expect(apiMocks.weatherStatus).not.toHaveBeenCalled();
    expect(apiMocks.weatherForecast).not.toHaveBeenCalled();
  });

  it('renders prop history newest first with Chinese type labels and no mutation UI', async () => {
    await renderDetails();
    await click(button('生活记录'));

    const rows = Array.from(container!.querySelectorAll('[data-testid="life-history-list"] li'));
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('事件'),
      expect.stringContaining('主动联系'),
      expect.stringContaining('活动')
    ]);
    expect(rows[0]?.textContent).toContain('把书架整理好了');
    expect(rows[1]?.textContent).toContain('分享读书感想');
    expect(rows[2]?.textContent).toContain('吃过早餐');

    const forbiddenLabels = ['新增地点', '删除', '设为当前城市', '立即刷新天气', '调整', '重置', '切换地点'];
    for (const label of forbiddenLabels) expect(container!.textContent).not.toContain(label);
    expect(apiMocks.createLocation).not.toHaveBeenCalled();
    expect(apiMocks.deleteLocation).not.toHaveBeenCalled();
    expect(apiMocks.overrideLocation).not.toHaveBeenCalled();
    expect(apiMocks.createCity).not.toHaveBeenCalled();
    expect(apiMocks.updateCity).not.toHaveBeenCalled();
    expect(apiMocks.weatherRefresh).not.toHaveBeenCalled();
    expect(apiMocks.adjustVitals).not.toHaveBeenCalled();
    expect(apiMocks.resetVitals).not.toHaveBeenCalled();
  });

  it('keeps the newest retry result when two retries overlap', async () => {
    const older = deferred<{ vitals: typeof vitals }>();
    const newer = deferred<{ vitals: typeof vitals }>();
    apiMocks.lifeVitals
      .mockRejectedValueOnce(new Error('第一次读取失败'))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    await renderDetails();
    await click(button('身体与节律'));

    const retry = button('重试');
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(apiMocks.lifeVitals).toHaveBeenCalledTimes(3);

    await act(async () => {
      newer.resolve({ vitals: { ...vitals, energy: 91 } });
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('91');

    await act(async () => {
      older.resolve({ vitals: { ...vitals, energy: 11 } });
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('91');
    expect(container!.textContent).not.toContain('11');
  });
});
