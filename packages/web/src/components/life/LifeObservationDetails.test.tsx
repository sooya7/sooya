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
  weatherForecast: vi.fn()
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
      lifeOverview: apiMocks.lifeOverview,
      lifeVitals: apiMocks.lifeVitals,
      lifeLocations: apiMocks.lifeLocations,
      lifeCities: apiMocks.lifeCities,
      lifeTravel: apiMocks.lifeTravel,
      weatherStatus: apiMocks.weatherStatus,
      weatherForecast: apiMocks.weatherForecast
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
  log: [{
    id: 'activity-old',
    activity: '吃过早餐',
    kind: 'meal',
    mood: '轻松',
    started_at: '2026-08-09T06:30:00.000Z',
    ended_at: '2026-08-09T07:00:00.000Z',
    shared: 0
  }],
  plans: [],
  events: [{
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
  }],
  proactive: [{
    id: 'proactive-middle',
    candidateId: 'candidate-1',
    candidateKind: 'reading',
    candidateActivity: '分享读书感想',
    status: 'sent',
    blockedReason: null,
    requestedMode: 'text',
    finalMode: 'text',
    fallbackReason: null,
    messageId: null,
    momentId: 'moment-1',
    sendSuccess: true,
    userResponseMessageId: null,
    userRespondedAt: null,
    detail: {},
    createdAt: '2026-08-09T08:00:00.000Z',
    updatedAt: '2026-08-09T08:00:00.000Z'
  }],
  reachOut: {
    reach: false,
    reason: 'nothing_worth_saying',
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
  weather: 'clear',
  vitals: {
    energy: 72,
    hunger: 25,
    stress: 18,
    social_need: 35,
    loneliness: 12,
    curiosity: 81,
    comfort: 76,
    focus: 64,
    sleep_debt: 1.5
  },
  activePlan: null,
  openThreads: [{ id: 'thread-1', title: '慢慢整理房间', progress: 42 }],
  recentEvents: []
};

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

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.life.mockResolvedValue(structuredClone(data));
  apiMocks.lifeOverview.mockResolvedValue(structuredClone(overview));
  apiMocks.lifeLocations.mockResolvedValue({ locations: [], current: null });
  apiMocks.lifeTravel.mockResolvedValue({ travel: null });
  apiMocks.weatherStatus.mockResolvedValue({
    enabled: true,
    provider: { name: 'open-meteo', configured: true, active: true },
    currentSource: 'open-meteo',
    lastSnapshot: null,
    cacheAgeSec: null,
    daylight: null,
    forecast: null
  });
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
  it('sits in one compact secondary card after the plan preview', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<LifeObservationPanel onNotice={vi.fn()} />);
    });

    const plans = container.querySelector('[data-testid="life-preview"]');
    const secondary = container.querySelector('[data-testid="life-secondary-card"]');
    const details = container.querySelector('[data-testid="life-observation-details"]');
    expect(plans?.nextElementSibling).toBe(secondary);
    expect(secondary?.contains(details)).toBe(true);
    expect(secondary?.textContent).toContain('正在发展的事');
    expect(secondary?.textContent).toContain('生活记录');
    expect(secondary?.textContent).toContain('最近活动');
    expect(secondary?.textContent).not.toContain('地点与天气');
  });

  it('uses overview/data props only and never calls the old duplicate detail APIs', async () => {
    await renderDetails();

    expect(apiMocks.lifeVitals).not.toHaveBeenCalled();
    expect(apiMocks.lifeLocations).not.toHaveBeenCalled();
    expect(apiMocks.lifeCities).not.toHaveBeenCalled();
    expect(apiMocks.lifeTravel).not.toHaveBeenCalled();
    expect(apiMocks.weatherStatus).not.toHaveBeenCalled();
    expect(apiMocks.weatherForecast).not.toHaveBeenCalled();

    const threadsToggle = button('正在发展的事');
    const panelId = threadsToggle.getAttribute('aria-controls');
    expect(threadsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(panelId!)?.hidden).toBe(true);
    expect(container!.textContent).not.toContain('慢慢整理房间');

    await click(threadsToggle);

    expect(threadsToggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(panelId!)?.hidden).toBe(false);
    expect(container!.textContent).toContain('慢慢整理房间');
    expect(container!.textContent).toContain('42%');
    expect(apiMocks.lifeVitals).not.toHaveBeenCalled();
    expect(apiMocks.lifeLocations).not.toHaveBeenCalled();
    expect(apiMocks.weatherStatus).not.toHaveBeenCalled();
  });

  it('renders only activity history inside its own scroll surface', async () => {
    await renderDetails();
    await click(button('生活记录'));

    const scroll = container!.querySelector('[data-testid="life-history-scroll"]');
    const rows = Array.from(container!.querySelectorAll('[data-testid="life-history-list"] li'));
    expect(scroll).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('活动');
    expect(rows[0]?.textContent).toContain('吃过早餐');
    expect(rows[0]?.textContent).toContain('轻松');
    expect(container!.textContent).not.toContain('把书架整理好了');
    expect(container!.textContent).not.toContain('分享读书感想');
    expect(scroll?.textContent).not.toContain('动态');

    const forbiddenLabels = ['新增地点', '删除', '设为当前城市', '立即刷新天气', '调整', '重置', '切换地点'];
    for (const label of forbiddenLabels) expect(container!.textContent).not.toContain(label);
  });
});
