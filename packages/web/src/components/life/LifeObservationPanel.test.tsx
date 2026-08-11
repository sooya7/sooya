// @vitest-environment jsdom
import { act, StrictMode } from 'react';
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

function setNumberValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

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
  location: { id: 'home', name: '家', kind: 'home' },
  weather: 'rain',
  vitals: {
    energy: 7,
    hunger: 38,
    stress: 0,
    social_need: 11,
    loneliness: 9,
    curiosity: 96,
    comfort: 100,
    focus: 100,
    sleep_debt: 0
  },
  activePlan: null,
  openThreads: [{ id: 'thread-1', title: '慢慢整理房间', progress: 42 }],
  recentEvents: []
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

async function renderPanel({ strict = false }: { strict?: boolean } = {}): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const panel = <LifeObservationPanel onNotice={vi.fn()} />;
  await act(async () => { root!.render(strict ? <StrictMode>{panel}</StrictMode> : panel); });
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LifeObservationPanel', () => {
  it('renders the compact overview from the two primary read APIs', async () => {
    await renderPanel();

    const panel = container!.querySelector('[data-testid="life-observation"]');
    expect(panel?.className).toBe('life-observation');
    expect(panel?.textContent).toContain('状态会随时间自行变化');

    const hero = panel?.querySelector('[data-testid="life-hero"]');
    expect(hero?.textContent).toContain('SOOYA 当前状态');
    expect(hero?.textContent).toContain('在沙发上打盹');
    expect(hero?.textContent).toContain('睡觉 · 心情困倦');
    expect(hero?.textContent).toContain('13:00');
    expect(hero?.textContent).toContain('家');
    expect(hero?.textContent).toContain('雨');
    expect(hero?.textContent).toContain('0/3 次');
    expect(hero?.textContent).toContain('她在睡觉');

    const vitals = panel?.querySelector('[data-testid="life-vitals-grid"]');
    expect(vitals?.children).toHaveLength(9);
    expect(vitals?.textContent).toContain('精力7很低');
    expect(vitals?.textContent).toContain('压力0很轻松');
    expect(vitals?.textContent).toContain('舒适度100极佳');
    expect(vitals?.textContent).toContain('睡眠债0 小时无欠债');

    const plans = panel?.querySelector('[data-testid="life-preview"]');
    expect(plans?.textContent).toContain('可能会做');
    expect(plans?.textContent).toContain('由她自行决定');
    expect(plans?.textContent).toContain('读完手边这本书');
    expect(plans?.textContent).toContain('阅读 · 可能');
    expect(plans?.textContent).toContain('15:00');

    const secondary = panel?.querySelector('[data-testid="life-secondary-card"]');
    expect(secondary?.textContent).toContain('正在发展的事');
    expect(secondary?.textContent).toContain('生活记录');
    expect(secondary?.textContent).toContain('联系边界');
    expect(secondary?.textContent).not.toContain('慢慢整理房间');
    expect(panel?.textContent).toContain('刚刚更新');
    expect(panel?.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('never renders intervention controls or calls mutation APIs', async () => {
    await renderPanel();

    const forbiddenLabels = ['立即推进', '添加计划', '开始', '暂停', '完成', '调整', '重置', '切换地点'];
    const buttons = Array.from(container!.querySelectorAll('button')).map((button) => button.textContent?.trim());
    for (const label of forbiddenLabels) {
      expect(buttons.some((text) => text?.includes(label))).toBe(false);
    }
    expect(apiMocks.tickLife).not.toHaveBeenCalled();
    expect(apiMocks.createLifePlan).not.toHaveBeenCalled();
    expect(apiMocks.updateLifePlan).not.toHaveBeenCalled();
    expect(apiMocks.adjustVitals).not.toHaveBeenCalled();
    expect(apiMocks.resetVitals).not.toHaveBeenCalled();
    expect(apiMocks.updateThread).not.toHaveBeenCalled();
    expect(apiMocks.overrideLocation).not.toHaveBeenCalled();
  });

  it('refreshes both primary read APIs after 30 seconds without remounting', async () => {
    await renderPanel();
    expect(apiMocks.life).toHaveBeenCalledTimes(1);
    expect(apiMocks.lifeOverview).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(apiMocks.life).toHaveBeenCalledTimes(2);
    expect(apiMocks.lifeOverview).toHaveBeenCalledTimes(2);
  });

  it('preserves an unsaved boundary draft across a 30-second refresh', async () => {
    await renderPanel();

    const boundaries = container!.querySelector('[data-testid="life-boundaries"]')!;
    await act(async () => {
      boundaries.querySelector<HTMLButtonElement>('.life-disclosure-toggle')!.click();
    });
    const gap = boundaries.querySelector<HTMLInputElement>('input[name="quietGapMinutes"]')!;
    expect(gap.value).toBe('90');
    await act(async () => { setNumberValue(gap, '240'); });

    const refreshed = structuredClone(panelData);
    refreshed.settings = { ...panelData.settings, quietGapMinutes: 30 };
    apiMocks.life.mockResolvedValueOnce(refreshed);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(gap.value).toBe('240');
  });

  it('keeps the newest response when two polls overlap in the same lifecycle', async () => {
    const olderData = deferred<LifePanelData>();
    const olderOverview = deferred<AdminLifeOverview>();
    const newerData = deferred<LifePanelData>();
    const newerOverview = deferred<AdminLifeOverview>();
    apiMocks.life
      .mockResolvedValueOnce(structuredClone(panelData))
      .mockReturnValueOnce(olderData.promise)
      .mockReturnValueOnce(newerData.promise);
    apiMocks.lifeOverview
      .mockResolvedValueOnce(structuredClone(overview))
      .mockReturnValueOnce(olderOverview.promise)
      .mockReturnValueOnce(newerOverview.promise);

    await renderPanel();
    expect(container!.textContent).toContain('在沙发上打盹');

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiMocks.life).toHaveBeenCalledTimes(3);
    expect(apiMocks.lifeOverview).toHaveBeenCalledTimes(3);

    const newest = structuredClone(panelData);
    newest.snapshot.activity = '最新的轮询状态';
    await act(async () => {
      newerData.resolve(newest);
      newerOverview.resolve(structuredClone(overview));
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('最新的轮询状态');

    const older = structuredClone(panelData);
    older.snapshot.activity = '较旧的轮询状态';
    await act(async () => {
      olderData.resolve(older);
      olderOverview.resolve(structuredClone(overview));
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('最新的轮询状态');
    expect(container!.textContent).not.toContain('较旧的轮询状态');
  });

  it('keeps the latest StrictMode lifecycle response when an older request resolves last', async () => {
    const firstData = deferred<LifePanelData>();
    const firstOverview = deferred<AdminLifeOverview>();
    const secondData = deferred<LifePanelData>();
    const secondOverview = deferred<AdminLifeOverview>();
    apiMocks.life
      .mockReturnValueOnce(firstData.promise)
      .mockReturnValueOnce(secondData.promise);
    apiMocks.lifeOverview
      .mockReturnValueOnce(firstOverview.promise)
      .mockReturnValueOnce(secondOverview.promise);

    await renderPanel({ strict: true });
    expect(apiMocks.life).toHaveBeenCalledTimes(2);

    const newestData = structuredClone(panelData);
    newestData.snapshot.activity = '正在准备晚饭';
    const newestOverview = structuredClone(overview);
    newestOverview.vitals = { ...overview.vitals!, energy: 91 };
    await act(async () => {
      secondData.resolve(newestData);
      secondOverview.resolve(newestOverview);
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('正在准备晚饭');
    expect(container!.querySelector('[data-vital="energy"]')?.textContent).toContain('91');

    await act(async () => {
      firstData.resolve(structuredClone(panelData));
      firstOverview.resolve(structuredClone(overview));
      await Promise.resolve();
    });
    expect(container!.textContent).toContain('正在准备晚饭');
    expect(container!.textContent).not.toContain('在沙发上打盹');
    expect(container!.querySelector('[data-vital="energy"]')?.textContent).toContain('91');
  });

  it('stops polling after unmount while a read is in flight', async () => {
    const pendingData = deferred<LifePanelData>();
    const pendingOverview = deferred<AdminLifeOverview>();
    apiMocks.life.mockReturnValueOnce(pendingData.promise);
    apiMocks.lifeOverview.mockReturnValueOnce(pendingOverview.promise);
    await renderPanel();

    const current = root!;
    await act(async () => { current.unmount(); });
    root = null;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiMocks.life).toHaveBeenCalledTimes(1);
    expect(apiMocks.lifeOverview).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingData.resolve(structuredClone(panelData));
      pendingOverview.resolve(structuredClone(overview));
      await Promise.resolve();
    });
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
    expect(container!.textContent).toContain('上次成功更新于 13:00');
    expect(Array.from(container!.querySelectorAll('button')).some((button) => button.textContent === '重试')).toBe(true);
  });
});
