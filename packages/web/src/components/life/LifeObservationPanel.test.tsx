// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminLifeOverview } from '../../lib/admin.js';
import type { LifePanelData } from '../../lib/features.js';
import { LifeObservationPanel } from './LifeObservationPanel.js';

const apiMocks = vi.hoisted(() => ({
  life: vi.fn(),
  lifeOverview: vi.fn(),
  tickLife: vi.fn(),
  createLifePlan: vi.fn(),
  updateLifePlan: vi.fn(),
  adjustVitals: vi.fn(),
  resetVitals: vi.fn(),
  updateThread: vi.fn(),
  overrideLocation: vi.fn()
}));

vi.mock('../../lib/features.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/features.js')>();
  return {
    ...original,
    featureApi: {
      ...original.featureApi,
      life: apiMocks.life,
      tickLife: apiMocks.tickLife,
      createLifePlan: apiMocks.createLifePlan,
      updateLifePlan: apiMocks.updateLifePlan
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
      adjustVitals: apiMocks.adjustVitals,
      resetVitals: apiMocks.resetVitals,
      updateThread: apiMocks.updateThread,
      overrideLocation: apiMocks.overrideLocation
    }
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const panelData: LifePanelData = {
  snapshot: {
    activity: '在沙发上打盹',
    kind: 'sleep',
    mood: '困倦',
    startedAt: '2026-08-09T04:00:00.000Z',
    endsAt: '2026-08-09T06:00:00.000Z',
    recent: []
  },
  log: [],
  plans: [
    {
      id: 'plan-reading',
      title: '读完手边这本书',
      kind: 'reading',
      planned_start: '2026-08-09T07:00:00.000Z',
      planned_end: null,
      status: 'planned',
      source: 'self',
      priority: 2,
      created_at: '2026-08-09T03:00:00.000Z',
      updated_at: '2026-08-09T03:00:00.000Z'
    }
  ],
  events: [],
  proactive: [],
  reachOut: {
    reach: false,
    reason: 'asleep',
    candidate: null,
    sharedLastDay: 0,
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
  snapshot: { activity: '在沙发上打盹', kind: 'sleep', mood: '困倦' },
  location: null,
  weather: null,
  vitals: null,
  activePlan: null,
  openThreads: [{ id: 'thread-1', title: '慢慢整理房间', progress: 42 }],
  recentEvents: []
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderPanel(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<LifeObservationPanel onNotice={vi.fn()} />); });
}

async function flushPromises(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

function setSuccessfulReads(): void {
  apiMocks.life.mockResolvedValue(structuredClone(panelData));
  apiMocks.lifeOverview.mockResolvedValue(structuredClone(overview));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-09T05:00:00.000Z'));
  vi.clearAllMocks();
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
  vi.useRealTimers();
});

describe('LifeObservationPanel', () => {
  it('loads and renders the autonomous read-only overview', async () => {
    await renderPanel();

    const panel = container!.querySelector('[data-testid="life-observation"]');
    expect(panel?.className).toBe('life-observation');
    expect(panel?.querySelector('[data-testid="life-now-summary"]')?.textContent).toContain('此刻 · 13:00');
    expect(panel?.textContent).toContain('状态会随时间自行变化');
    expect(panel?.textContent).toContain('在沙发上打盹');
    expect(panel?.textContent).toContain('睡觉');
    expect(panel?.textContent).toContain('心情困倦');
    expect(panel?.textContent).toContain('已经 1 小时，还有 1 小时');
    expect(panel?.textContent).toContain('她在睡觉');
    expect(panel?.querySelector('[data-testid="life-preview"]')?.textContent).toContain('今天可能会做');
    expect(panel?.textContent).toContain('由她自行决定');
    expect(panel?.textContent).toContain('读完手边这本书');
    expect(panel?.textContent).toContain('阅读 · 可能');
    expect(panel?.querySelector('[data-testid="life-threads-preview"]')?.textContent).toContain('正在发展的事');
    expect(panel?.textContent).toContain('慢慢整理房间');
    expect(panel?.textContent).toContain('42%');
    expect(panel?.textContent).toContain('刚刚更新');
  });

  it('never renders intervention controls or calls mutation APIs', async () => {
    await renderPanel();

    const forbiddenLabels = ['立即推进', '添加计划', '开始', '暂停', '完成', '调整', '重置', '切换地点'];
    const buttons = Array.from(container!.querySelectorAll('button')).map((button) => button.textContent?.trim());
    for (const label of forbiddenLabels) expect(buttons).not.toContain(label);
    expect(apiMocks.tickLife).not.toHaveBeenCalled();
    expect(apiMocks.createLifePlan).not.toHaveBeenCalled();
    expect(apiMocks.updateLifePlan).not.toHaveBeenCalled();
    expect(apiMocks.adjustVitals).not.toHaveBeenCalled();
    expect(apiMocks.resetVitals).not.toHaveBeenCalled();
    expect(apiMocks.updateThread).not.toHaveBeenCalled();
    expect(apiMocks.overrideLocation).not.toHaveBeenCalled();
  });

  it('refreshes both read APIs after 30 seconds without remounting', async () => {
    await renderPanel();
    expect(apiMocks.life).toHaveBeenCalledTimes(1);
    expect(apiMocks.lifeOverview).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(apiMocks.life).toHaveBeenCalledTimes(2);
    expect(apiMocks.lifeOverview).toHaveBeenCalledTimes(2);
  });

  it('shows an alert and retry action when the first read fails', async () => {
    apiMocks.life.mockRejectedValueOnce(new Error('读取失败'));
    await renderPanel();

    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('读取失败');
    const retry = Array.from(container!.querySelectorAll('button')).find((button) => button.textContent === '重新读取');
    expect(retry).toBeDefined();
    await act(async () => { retry!.click(); });
    await flushPromises();
    expect(apiMocks.life).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain('在沙发上打盹');
  });

  it('keeps the last successful view and marks it stale after a refresh failure', async () => {
    await renderPanel();
    apiMocks.life.mockRejectedValueOnce(new Error('暂时离线'));

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(container!.textContent).toContain('在沙发上打盹');
    expect(container!.textContent).toContain('更新失败，正在显示上次成功读取的状态。');
    expect(Array.from(container!.querySelectorAll('button')).some((button) => button.textContent === '重试')).toBe(true);
  });
});
