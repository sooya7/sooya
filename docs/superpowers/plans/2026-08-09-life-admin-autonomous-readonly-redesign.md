# Autonomous Read-Only Life Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two current life-management surfaces with one uncluttered `/admin/life` observation page that never exposes life-intervention controls, while preserving the existing backend APIs and editable contact-boundary settings.

**Architecture:** Add a focused `LifeObservationPanel` to the existing admin console and split its pure view-model, lazy read-only details, and editable contact-boundary form into separate modules. Reuse the existing read APIs, stop importing mutation clients in the page, remove the standalone `LifeAdminPage`, and let the existing admin-path canonicalizer turn `/admin/life/console` into `/admin/life`.

**Tech Stack:** React 19, TypeScript, Vitest + jsdom, Vite, Playwright, existing `featureApi`/`adminApi`, existing `AdminPanel.css` theme tokens.

---

## File map

**Create**

- `packages/web/src/lib/lifeObservation.ts` — pure labels, preview selection, history merging, and contact-boundary payload construction.
- `packages/web/src/lib/lifeObservation.test.ts` — unit tests for those pure transformations.
- `packages/web/src/components/life/LifeObservationPanel.tsx` — page coordinator and always-visible read-only overview.
- `packages/web/src/components/life/LifeObservationPanel.test.tsx` — overview, polling, autonomy, and stale-data behavior.
- `packages/web/src/components/life/LifeObservationDetails.tsx` — accessible disclosure sections and lazy read-only vitals/environment/history views.
- `packages/web/src/components/life/LifeObservationDetails.test.tsx` — lazy loading, isolated errors, and read-only detail tests.
- `packages/web/src/components/life/LifeContactBoundaryForm.tsx` — the only editable part of the page.
- `packages/web/src/components/life/LifeContactBoundaryForm.test.tsx` — allowed payload, save feedback, and draft preservation tests.

**Modify**

- `packages/web/src/components/AdminPanel.tsx` — render `LifeObservationPanel` for the `life` tab.
- `packages/web/src/components/FeatureAdminPage.tsx` — remove the old `LifeAdminLink` and `LifePanel`; keep unrelated feature editors.
- `packages/web/src/components/FeatureAdminPage.test.tsx` — move life-label expectations to the new helper test.
- `packages/web/src/AppShell.tsx` — remove the standalone life-console branch.
- `packages/web/src/AppShell.test.tsx` — verify `/admin/life/console` still uses the single admin shell.
- `packages/web/src/components/adminConsole.test.ts` — enforce one life panel import and no duplicate-console entry.
- `packages/web/src/components/AdminPanel.css` — add the flat observation-page layout and remove obsolete embedded-life rules.
- `packages/web/src/styles.css` — remove CSS used only by the deleted standalone console.
- `packages/web/src/components/styleTokens.test.ts` — replace obsolete `.life-rules` assertions with flat-layout and mobile-overflow contracts.
- `e2e/mobile-admin-ux.e2e.ts` — verify the 375px observation page and contact-boundary form.
- `e2e/next-phase.e2e.ts` — update the old console route and location/weather assertions for the unified page.

**Delete**

- `packages/web/src/components/LifeAdminPage.tsx` — obsolete standalone management console.
- `packages/web/src/components/LifeAdminPage.test.tsx` — replaced by focused unified-page tests.

## Task 1: Build the pure life-observation view model

**Files:**

- Create: `packages/web/src/lib/lifeObservation.ts`
- Create: `packages/web/src/lib/lifeObservation.test.ts`
- Modify: `packages/web/src/components/FeatureAdminPage.test.tsx`

- [ ] **Step 1: Write failing transformation tests**

Create `packages/web/src/lib/lifeObservation.test.ts` with concrete coverage for labels, preview selection, merged history, and the contact-boundary allowlist:

```ts
import { describe, expect, it } from 'vitest';
import type { LifePanelData, LifeSettings } from './features.js';
import {
  contactBoundaryPayload,
  lifeKindLabel,
  lifePlanStatusText,
  mergeLifeHistory,
  previewPlans
} from './lifeObservation.js';

const settings: LifeSettings = {
  reachOut: true,
  quietGapMinutes: 180,
  maxReachOutsPerDay: 3,
  silentFrom: 0,
  silentTo: 9,
  tzOffsetMinutes: 480,
  proactiveMode: 'auto'
};

const plans: LifePanelData['plans'] = [
  { id: 'done', title: '做完的事', kind: 'chore', planned_start: null, planned_end: null, status: 'completed', source: 'engine', priority: 1, created_at: '2026-08-09T01:00:00Z', updated_at: '2026-08-09T01:00:00Z' },
  { id: 'p1', title: '沿街溜达', kind: 'out', planned_start: '2026-08-09T03:00:00Z', planned_end: null, status: 'planned', source: 'engine', priority: 5, created_at: '2026-08-09T02:00:00Z', updated_at: '2026-08-09T02:00:00Z' },
  { id: 'p2', title: '买杯拿铁', kind: 'out', planned_start: null, planned_end: null, status: 'active', source: 'engine', priority: 9, created_at: '2026-08-09T03:00:00Z', updated_at: '2026-08-09T03:00:00Z' },
  { id: 'p3', title: '顺路买东西', kind: 'chore', planned_start: null, planned_end: null, status: 'planned', source: 'engine', priority: 2, created_at: '2026-08-09T04:00:00Z', updated_at: '2026-08-09T04:00:00Z' },
  { id: 'p4', title: '晚点读书', kind: 'reading', planned_start: null, planned_end: null, status: 'planned', source: 'engine', priority: 1, created_at: '2026-08-09T05:00:00Z', updated_at: '2026-08-09T05:00:00Z' }
];

describe('lifeObservation', () => {
  it('uses Chinese labels without exposing raw kinds or statuses', () => {
    expect(lifeKindLabel('out')).toBe('出门');
    expect(lifeKindLabel('sleep')).toBe('睡觉');
    expect(lifePlanStatusText('active')).toBe('正在进行');
    expect(lifePlanStatusText('planned')).toBe('可能');
  });

  it('shows the active plan first, excludes terminal plans and limits the preview to three', () => {
    expect(previewPlans(plans).map((plan) => plan.id)).toEqual(['p2', 'p1', 'p3']);
  });

  it('merges activities, events and proactive attempts newest-first', () => {
    const history = mergeLifeHistory(
      [{ id: 'l1', activity: '读书', kind: 'reading', mood: 'calm', started_at: '2026-08-09T01:00:00Z', ended_at: '2026-08-09T02:00:00Z', shared: 0 }],
      [{ id: 'e1', plan_id: null, log_id: null, event_type: 'activity.finished', activity: '散步', kind: 'out', description: '散步回家', mood_before: null, mood_after: null, happened_at: '2026-08-09T04:00:00Z', shareable: 1, shared_at: null, created_at: '2026-08-09T04:00:00Z' }],
      [{ id: 'a1', candidateId: null, candidateKind: null, candidateActivity: '买到拿铁', status: 'sent', blockedReason: null, requestedMode: 'text', finalMode: 'text', fallbackReason: null, messageId: 'm1', sendSuccess: true, userResponseMessageId: null, userRespondedAt: null, detail: {}, createdAt: '2026-08-09T03:00:00Z', updatedAt: '2026-08-09T03:00:00Z' }]
    );
    expect(history.map((item) => item.kind)).toEqual(['event', 'proactive', 'activity']);
  });

  it('sends only contact-boundary fields', () => {
    expect(contactBoundaryPayload({ ...settings, tzOffsetMinutes: 999 })).toEqual({
      reachOut: true,
      quietGapMinutes: 180,
      maxReachOutsPerDay: 3,
      silentFrom: 0,
      silentTo: 9,
      proactiveMode: 'auto'
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```powershell
npm test -w @sooya/web -- src/lib/lifeObservation.test.ts
```

Expected: FAIL because `lifeObservation.ts` does not exist.

- [ ] **Step 3: Implement the pure helpers**

Create `packages/web/src/lib/lifeObservation.ts` with these exported contracts:

```ts
import type { LifeEventRow, LifeLogRow, LifePanelData, LifePlanRow, LifeSettings, ProactiveAttempt } from './features.js';

const LIFE_KIND_LABELS: Record<string, string> = {
  chore: '家务', out: '出门', play: '玩耍', meal: '吃饭', rest: '休息',
  sleep: '睡觉', study: '学习', work: '工作', wake: '起床',
  wind_down: '睡前放松', reading: '阅读', task: '任务'
};

const LIFE_PLAN_STATUS_LABELS: Record<string, string> = {
  planned: '可能', active: '正在进行', paused: '暂时搁置', completed: '已经完成',
  cancelled: '已经放下', skipped: '没有去做'
};

export function lifeKindLabel(value: string): string {
  return LIFE_KIND_LABELS[value] ?? value;
}

export function lifePlanStatusText(value: string): string {
  return LIFE_PLAN_STATUS_LABELS[value] ?? value;
}

export function previewPlans(plans: LifePlanRow[]): LifePlanRow[] {
  const visible = plans.filter((plan) => plan.status === 'active' || plan.status === 'planned' || plan.status === 'paused');
  return visible
    .slice()
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active')
      || Number(b.priority) - Number(a.priority)
      || String(a.planned_start ?? a.created_at).localeCompare(String(b.planned_start ?? b.created_at)))
    .slice(0, 3);
}

export type LifeHistoryItem =
  | { kind: 'activity'; id: string; at: string; title: string; detail: string }
  | { kind: 'event'; id: string; at: string; title: string; detail: string }
  | { kind: 'proactive'; id: string; at: string; title: string; detail: string };

export function mergeLifeHistory(log: LifeLogRow[], events: LifeEventRow[], proactive: ProactiveAttempt[]): LifeHistoryItem[] {
  return [
    ...log.map((row): LifeHistoryItem => ({ kind: 'activity', id: row.id, at: row.ended_at, title: row.activity, detail: row.shared ? '已经分享' : row.mood })),
    ...events.map((row): LifeHistoryItem => ({ kind: 'event', id: row.id, at: row.happened_at, title: row.description, detail: lifeKindLabel(row.kind) })),
    ...proactive.map((row): LifeHistoryItem => ({ kind: 'proactive', id: row.id, at: row.createdAt, title: row.candidateActivity ?? '主动联系尝试', detail: row.status === 'sent' ? '已经发送' : row.status === 'blocked' ? '没有打扰你' : '发送失败' }))
  ].sort((a, b) => b.at.localeCompare(a.at));
}

export function contactBoundaryPayload(settings: LifeSettings): Partial<LifePanelData['settings']> {
  return {
    reachOut: settings.reachOut,
    quietGapMinutes: settings.quietGapMinutes,
    maxReachOutsPerDay: settings.maxReachOutsPerDay,
    silentFrom: settings.silentFrom,
    silentTo: settings.silentTo,
    proactiveMode: settings.proactiveMode ?? 'auto'
  };
}
```

- [ ] **Step 4: Move the kind-label test ownership**

In `packages/web/src/components/FeatureAdminPage.test.tsx`, remove `lifeKindLabel` from the import and delete the test that belongs to life rendering. The new helper test now owns that behavior.

- [ ] **Step 5: Run the focused tests and verify green**

Run:

```powershell
npm test -w @sooya/web -- src/lib/lifeObservation.test.ts src/components/FeatureAdminPage.test.tsx
```

Expected: both files PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/web/src/lib/lifeObservation.ts packages/web/src/lib/lifeObservation.test.ts packages/web/src/components/FeatureAdminPage.test.tsx
git commit -m "test(life): define read-only observation view model"
```

## Task 2: Render the autonomous read-only overview

**Files:**

- Create: `packages/web/src/components/life/LifeObservationPanel.tsx`
- Create: `packages/web/src/components/life/LifeObservationPanel.test.tsx`

- [ ] **Step 1: Write a failing overview/autonomy test**

Create `packages/web/src/components/life/LifeObservationPanel.test.tsx`. Mock `featureApi.life` and `adminApi.lifeOverview`, render the panel, and assert the visible contract and absence of controls:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifeObservationPanel } from './LifeObservationPanel.js';

const api = vi.hoisted(() => ({
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

vi.mock('../../lib/features.js', () => ({
  featureApi: {
    life: api.life,
    tickLife: api.tickLife,
    createLifePlan: api.createLifePlan,
    updateLifePlan: api.updateLifePlan
  }
}));

vi.mock('../../lib/admin.js', () => ({
  adminApi: {
    lifeOverview: api.lifeOverview,
    adjustVitals: api.adjustVitals,
    resetVitals: api.resetVitals,
    updateThread: api.updateThread,
    overrideLocation: api.overrideLocation
  }
}));

const lifeData = {
  snapshot: { activity: '抱着被子睡', kind: 'sleep', mood: '安静', startedAt: '2026-08-09T00:00:00Z', endsAt: '2026-08-09T08:00:00Z', recent: [] },
  log: [],
  plans: [
    { id: 'p1', title: '沿街溜达', kind: 'out', planned_start: null, planned_end: null, status: 'planned', source: 'engine', priority: 1, created_at: '2026-08-09T00:00:00Z', updated_at: '2026-08-09T00:00:00Z' }
  ],
  events: [],
  proactive: [],
  reachOut: { reach: false, reason: 'asleep', candidate: null, sharedLastDay: 0, lastUserAt: null, lastAssistantAt: null, enabledByDeployment: true },
  settings: { reachOut: true, quietGapMinutes: 180, maxReachOutsPerDay: 3, silentFrom: 0, silentTo: 9, tzOffsetMinutes: 480, proactiveMode: 'auto' }
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-09T05:24:00Z'));
  api.life.mockResolvedValue(lifeData);
  api.lifeOverview.mockResolvedValue({ snapshot: lifeData.snapshot, location: { id: 'home', name: '家', kind: 'home' }, weather: null, vitals: null, activePlan: null, openThreads: [{ id: 't1', title: '看书', progress: 10 }], recentEvents: [] });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('LifeObservationPanel', () => {
  it('explains the current life without rendering intervention controls', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root!.render(<LifeObservationPanel onNotice={vi.fn()} />); await Promise.resolve(); });

    expect(container.textContent).toContain('抱着被子睡');
    expect(container.textContent).toContain('她在睡觉');
    expect(container.textContent).toContain('沿街溜达');
    expect(container.textContent).toContain('正在发展的事');
    for (const label of ['立即推进', '添加计划', '开始', '暂停', '完成', '调整', '重置', '切换地点']) {
      expect([...container.querySelectorAll('button')].some((button) => button.textContent?.includes(label))).toBe(false);
    }
    expect(api.tickLife).not.toHaveBeenCalled();
    expect(api.createLifePlan).not.toHaveBeenCalled();
    expect(api.updateLifePlan).not.toHaveBeenCalled();
  });

  it('refreshes after 30 seconds without remounting the panel', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root!.render(<LifeObservationPanel onNotice={vi.fn()} />); await Promise.resolve(); });
    expect(api.life).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(api.life).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test and verify red**

Run:

```powershell
npm test -w @sooya/web -- src/components/life/LifeObservationPanel.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the coordinator and flat overview**

Create `LifeObservationPanel.tsx` with this state/data boundary and JSX hierarchy:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi, type AdminLifeOverview } from '../../lib/admin.js';
import { featureApi, type LifePanelData } from '../../lib/features.js';
import { herClock, reachReasonText, slotProgress } from '../../lib/lifeView.js';
import { lifeKindLabel, lifePlanStatusText, previewPlans } from '../../lib/lifeObservation.js';

export function LifeObservationPanel({ onNotice: _onNotice }: { onNotice: (message: string) => void }) {
  const [data, setData] = useState<LifePanelData | null>(null);
  const [overview, setOverview] = useState<AdminLifeOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextData, nextOverview] = await Promise.all([featureApi.life(), adminApi.lifeOverview()]);
      setData(nextData);
      setOverview(nextOverview);
      setUpdatedAt(new Date().toISOString());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const plans = useMemo(() => previewPlans(data?.plans ?? []), [data?.plans]);

  if (!data || !overview) {
    return <section className="life-observation" data-testid="life-observation">{error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => void load()}>重新读取</button></div> : <div className="life-observation-skeleton" aria-label="正在读取她的生活" />}</section>;
  }

  const progress = slotProgress(data.snapshot);
  return (
    <section className="life-observation" data-testid="life-observation">
      <header className="life-observation-heading">
        <p>状态会随时间自行变化</p>
        <small>{updatedAt ? `更新于 ${herClock(updatedAt, data.settings.tzOffsetMinutes)}` : '刚刚更新'}</small>
      </header>
      {error && <div className="life-stale-warning" role="status">更新失败，正在显示上次成功读取的状态。<button type="button" onClick={() => void load()}>重试</button></div>}
      <section className="life-now-summary" aria-labelledby="life-now-title">
        <p>此刻 · {herClock(new Date().toISOString(), data.settings.tzOffsetMinutes)}</p>
        <h2 id="life-now-title">{data.snapshot.activity} <span>· 心情{data.snapshot.mood}</span></h2>
        <p>已经 {progress.intoIt}，预计还有 {progress.left} 自然变化</p>
        <div className="life-progress" aria-label={`当前活动进度 ${progress.percent}%`}><i style={{ width: `${progress.percent}%` }} /></div>
        <p>{reachReasonText(data)}</p>
      </section>
      <section className="life-preview" aria-labelledby="life-preview-title">
        <div className="life-section-heading"><h2 id="life-preview-title">今天可能会做</h2><span>由她自行决定</span></div>
        {plans.length === 0 ? <p className="life-empty">她还没有决定接下来做什么。</p> : plans.map((plan) => <div className="life-preview-row" key={plan.id}><strong>{plan.title}</strong><span>{lifeKindLabel(plan.kind)} · {lifePlanStatusText(plan.status)}</span></div>)}
      </section>
      <section className="life-threads-preview" aria-labelledby="life-threads-title">
        <h2 id="life-threads-title">正在发展的事</h2>
        {overview.openThreads.length === 0 ? <p className="life-empty">暂时没有持续发展的事。</p> : overview.openThreads.map((thread) => <p key={thread.id}><strong>{thread.title}</strong><span>{thread.progress}%</span></p>)}
      </section>
    </section>
  );
}
```

Tasks 3 and 4 append the read-only detail disclosures and contact-boundary form after the threads preview. Task 2 remains a complete, runnable overview without empty component shells.

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```powershell
npm test -w @sooya/web -- src/components/life/LifeObservationPanel.test.tsx
npm run typecheck -w @sooya/web
```

Expected: test PASS and typecheck exits 0.

- [ ] **Step 5: Commit**

```powershell
git add packages/web/src/components/life/LifeObservationPanel.tsx packages/web/src/components/life/LifeObservationPanel.test.tsx
git commit -m "feat(life): add autonomous observation overview"
```

## Task 3: Add lazy, isolated, read-only detail sections

**Files:**

- Create: `packages/web/src/components/life/LifeObservationDetails.tsx`
- Create: `packages/web/src/components/life/LifeObservationDetails.test.tsx`
- Modify: `packages/web/src/components/life/LifeObservationPanel.tsx`

- [ ] **Step 1: Write failing lazy-load and isolation tests**

Mock `adminApi.lifeVitals`, `lifeLocations`, `lifeCities`, `lifeTravel`, `weatherStatus`, and `weatherForecast`. History uses the already loaded `LifePanelData`. Assert no detail call happens before expansion, the relevant calls happen once after expansion, and no mutation controls exist:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminLifeOverview } from '../../lib/admin.js';
import type { LifePanelData } from '../../lib/features.js';
import { LifeObservationDetails } from './LifeObservationDetails.js';

const api = vi.hoisted(() => ({
  lifeVitals: vi.fn(), lifeLocations: vi.fn(), lifeCities: vi.fn(),
  lifeTravel: vi.fn(), weatherStatus: vi.fn(), weatherForecast: vi.fn()
}));

vi.mock('../../lib/admin.js', () => ({ adminApi: api }));

const data: LifePanelData = {
  snapshot: { activity: '睡觉', kind: 'sleep', mood: '安静', startedAt: '2026-08-09T00:00:00Z', endsAt: '2026-08-09T08:00:00Z', recent: [] },
  log: [], plans: [], events: [], proactive: [],
  reachOut: { reach: false, reason: 'asleep', candidate: null, sharedLastDay: 0, lastUserAt: null, lastAssistantAt: null, enabledByDeployment: true },
  settings: { reachOut: true, quietGapMinutes: 180, maxReachOutsPerDay: 3, silentFrom: 0, silentTo: 9, tzOffsetMinutes: 480, proactiveMode: 'auto' }
};

const overview: AdminLifeOverview = {
  snapshot: { activity: '睡觉', kind: 'sleep', mood: '安静', theme: '慢生活', vitals: [] },
  location: { id: 'home', name: '家', kind: 'home' }, weather: '晴', vitals: null,
  activePlan: null, openThreads: [], recentEvents: []
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderDetails(): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<LifeObservationDetails data={data} overview={overview} />); });
}

function button(name: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(name));
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

beforeEach(() => {
  api.lifeVitals.mockResolvedValue({ vitals: { energy: 70, hunger: 40, stress: 20, social_need: 30, loneliness: 10, curiosity: 50, comfort: 60, focus: 45, sleep_debt: 1 } });
  api.lifeLocations.mockResolvedValue({ locations: [{ id: 'home', name: '家', kind: 'home', tags: [], indoor: true, visitWeight: 1, source: 'builtin', active: true }] });
  api.lifeCities.mockResolvedValue({ cities: [{ id: 'city', name: '宁波', region: '浙江', country: '中国', timeZone: 'Asia/Shanghai', active: true }] });
  api.lifeTravel.mockResolvedValue({ travel: null });
  api.weatherStatus.mockResolvedValue({ enabled: true, provider: { name: 'open-meteo', configured: true, active: true }, lastSnapshot: { observedAt: '2026-08-09T05:00:00Z', condition: 'clear', temperatureC: 26, provider: 'open-meteo', locationKey: 'ningbo', stale: false }, cacheAgeSec: 60, fallback: 'primary', daylight: null, forecast: null });
  api.weatherForecast.mockResolvedValue({ forecast: null });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('LifeObservationDetails', () => {
it('loads environment data only when its disclosure opens', async () => {
  await renderDetails();
  expect(api.lifeLocations).not.toHaveBeenCalled();
  expect(api.weatherStatus).not.toHaveBeenCalled();
  await act(async () => { button('地点与天气').click(); await Promise.resolve(); });
  expect(api.lifeLocations).toHaveBeenCalledTimes(1);
  expect(api.weatherStatus).toHaveBeenCalledTimes(1);
  expect(container!.textContent).toContain('家');
  expect(container!.textContent).toContain('晴');
  for (const forbidden of ['新增地点', '删除', '设为当前城市', '立即刷新天气']) {
    expect(container!.textContent).not.toContain(forbidden);
  }
});

it('keeps other sections usable when one detail request fails', async () => {
  api.lifeVitals.mockRejectedValueOnce(new Error('身体状态暂时不可用'));
  await renderDetails();
  await act(async () => { button('身体与节律').click(); await Promise.resolve(); });
  expect(container!.querySelector('[data-testid="life-vitals-detail"]')?.textContent).toContain('身体状态暂时不可用');
  await act(async () => { button('生活记录').click(); await Promise.resolve(); });
  expect(container!.querySelector('[data-testid="life-history-detail"]')).not.toBeNull();
});
});
```

- [ ] **Step 2: Run the focused test and verify red**

```powershell
npm test -w @sooya/web -- src/components/life/LifeObservationDetails.test.tsx
```

Expected: FAIL because `LifeObservationDetails.tsx` does not exist.

- [ ] **Step 3: Implement the accessible disclosure primitive**

Use a real button and preserve open state inside the component:

```tsx
function DisclosureSection({ id, title, summary, children, onFirstOpen }: { id: string; title: string; summary: string; children: ReactNode; onFirstOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const opened = useRef(false);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !opened.current) {
      opened.current = true;
      onFirstOpen();
    }
  };
  return <section className="life-disclosure"><button type="button" className="life-disclosure-toggle" aria-expanded={open} aria-controls={`${id}-panel`} onClick={toggle}><span><strong>{title}</strong><small>{summary}</small></span><span aria-hidden="true">⌄</span></button>{open && <div id={`${id}-panel`} className="life-disclosure-panel">{children}</div>}</section>;
}
```

- [ ] **Step 4: Implement independent lazy loaders**

Define one loader state per section so failures and retries stay local:

```tsx
type LoadState<T> = { data: T | null; error: string | null; loading: boolean };

function useLazyData<T>(load: () => Promise<T>) {
  const [state, setState] = useState<LoadState<T>>({ data: null, error: null, loading: false });
  const run = useCallback(async () => {
    setState((value) => ({ ...value, loading: true, error: null }));
    try { setState({ data: await load(), error: null, loading: false }); }
    catch (cause) { setState((value) => ({ ...value, error: cause instanceof Error ? cause.message : String(cause), loading: false })); }
  }, [load]);
  return { ...state, run };
}
```

Build three read-only disclosures:

- `身体与节律`: `adminApi.lifeVitals()`; render semantic labels and numbers only.
- `地点与天气`: parallel `lifeLocations`, `lifeCities`, `lifeTravel`, `weatherStatus`, and `weatherForecast`; render current/active values only.
- `生活记录`: use the already-loaded `LifePanelData` for log/events/proactive, merge with `mergeLifeHistory`, and allow a local read-only filter (`all`, `event`, `proactive`) if the list is long.
- Do not add a separate plans/threads disclosure; the always-visible previews already satisfy the approved page hierarchy.

For a failed section, render:

```tsx
<div className="life-detail-state" role="alert"><p>{error}</p><button type="button" onClick={() => void run()}>重试</button></div>
```

Import the completed detail component in `LifeObservationPanel.tsx` and render it immediately after `life-threads-preview`:

```tsx
import { LifeObservationDetails } from './LifeObservationDetails.js';

<LifeObservationDetails data={data} overview={overview} />
```

- [ ] **Step 5: Run focused tests and typecheck**

```powershell
npm test -w @sooya/web -- src/components/life/LifeObservationDetails.test.tsx src/components/life/LifeObservationPanel.test.tsx
npm run typecheck -w @sooya/web
```

Expected: all focused tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```powershell
git add packages/web/src/components/life/LifeObservationDetails.tsx packages/web/src/components/life/LifeObservationDetails.test.tsx packages/web/src/components/life/LifeObservationPanel.tsx
git commit -m "feat(life): add lazy read-only life details"
```

## Task 4: Keep only the editable contact-boundary form

**Files:**

- Create: `packages/web/src/components/life/LifeContactBoundaryForm.tsx`
- Create: `packages/web/src/components/life/LifeContactBoundaryForm.test.tsx`
- Modify: `packages/web/src/components/life/LifeObservationPanel.tsx`

- [ ] **Step 1: Write failing allowlist and draft-preservation tests**

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeSettings } from '../../lib/features.js';
import { LifeContactBoundaryForm } from './LifeContactBoundaryForm.js';

const api = vi.hoisted(() => ({ updateLifeSettings: vi.fn() }));
vi.mock('../../lib/features.js', () => ({ featureApi: { updateLifeSettings: api.updateLifeSettings } }));

const initial: LifeSettings = { reachOut: true, quietGapMinutes: 180, maxReachOutsPerDay: 3, silentFrom: 0, silentTo: 9, tzOffsetMinutes: 480, proactiveMode: 'auto' };
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderForm() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = async (value: LifeSettings) => { await act(async () => { root!.render(<LifeContactBoundaryForm initial={value} onNotice={vi.fn()} />); }); };
  await render(initial);
  await act(async () => { container!.querySelector<HTMLButtonElement>('.life-disclosure-toggle')!.click(); });
  return { rerender: async (patch: Partial<LifeSettings>) => render({ ...initial, ...patch }) };
}

beforeEach(() => {
  api.updateLifeSettings.mockImplementation(async (patch: Partial<LifeSettings>) => ({ settings: { ...initial, ...patch } }));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe('LifeContactBoundaryForm', () => {
it('submits only contact-boundary fields', async () => {
  await renderForm();
  const gap = container!.querySelector<HTMLInputElement>('input[name="quietGapMinutes"]')!;
  await act(async () => { gap.value = '240'; gap.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { container!.querySelector<HTMLFormElement>('form')!.requestSubmit(); await Promise.resolve(); });
  expect(api.updateLifeSettings).toHaveBeenCalledWith({
    reachOut: true,
    quietGapMinutes: 240,
    maxReachOutsPerDay: 3,
    silentFrom: 0,
    silentTo: 9,
    proactiveMode: 'auto'
  });
});

it('does not overwrite an unsaved draft when refreshed settings arrive', async () => {
  const { rerender } = await renderForm();
  const gap = container!.querySelector<HTMLInputElement>('input[name="quietGapMinutes"]')!;
  await act(async () => { gap.value = '240'; gap.dispatchEvent(new Event('input', { bubbles: true })); });
  await rerender({ quietGapMinutes: 90 });
  expect(container!.querySelector<HTMLInputElement>('input[name="quietGapMinutes"]')!.value).toBe('240');
});
});
```

- [ ] **Step 2: Run the test and verify red**

```powershell
npm test -w @sooya/web -- src/components/life/LifeContactBoundaryForm.test.tsx
```

Expected: FAIL because `LifeContactBoundaryForm.tsx` does not exist.

- [ ] **Step 3: Implement the boundary-only form**

Use local draft/dirty state and a real form so `AdminPanel`'s existing `onSubmitCapture` clears the global dirty flag:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { featureApi, type LifeSettings } from '../../lib/features.js';
import { contactBoundaryPayload } from '../../lib/lifeObservation.js';

export function LifeContactBoundaryForm({ initial, onNotice }: { initial: LifeSettings; onNotice: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!dirty) setDraft(initial); }, [dirty, initial]);

  const change = (patch: Partial<LifeSettings>) => { setDraft((value) => ({ ...value, ...patch })); setDirty(true); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await featureApi.updateLifeSettings(contactBoundaryPayload(draft));
      setDraft(result.settings);
      setDirty(false);
      onNotice('联系边界已保存');
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return <section className="life-disclosure life-boundaries" data-testid="life-boundaries"><button type="button" className="life-disclosure-toggle" aria-expanded={open} aria-controls="life-boundaries-panel" onClick={() => setOpen((value) => !value)}><span><strong>联系边界</strong><small>只决定她什么时候、以什么方式联系你</small></span><span aria-hidden="true">⌄</span></button>{open && <form id="life-boundaries-panel" className="life-boundary-form" onSubmit={(event) => void submit(event)}><label><span>允许主动联系</span><input name="reachOut" type="checkbox" checked={draft.reachOut} onChange={(event) => change({ reachOut: event.target.checked })} /></label><label><span>安静间隔（分钟）</span><input name="quietGapMinutes" type="number" min={5} max={1440} value={draft.quietGapMinutes} onChange={(event) => change({ quietGapMinutes: Number(event.target.value) })} /></label><label><span>每日主动联系上限</span><input name="maxReachOutsPerDay" type="number" min={0} max={20} value={draft.maxReachOutsPerDay} onChange={(event) => change({ maxReachOutsPerDay: Number(event.target.value) })} /></label><fieldset><legend>静默时段</legend><input aria-label="静默开始" name="silentFrom" type="number" min={0} max={23} value={draft.silentFrom} onChange={(event) => change({ silentFrom: Number(event.target.value) })} /><span>点至</span><input aria-label="静默结束" name="silentTo" type="number" min={0} max={23} value={draft.silentTo} onChange={(event) => change({ silentTo: Number(event.target.value) })} /><span>点</span></fieldset><label><span>主动分享方式</span><select name="proactiveMode" value={draft.proactiveMode ?? 'auto'} onChange={(event) => change({ proactiveMode: event.target.value as LifeSettings['proactiveMode'] })}><option value="auto">自动</option><option value="text">文字</option><option value="text_sticker">文字＋表情包</option><option value="voice">语音</option><option value="image">图片</option></select></label><p>这些设置不会改变她的心情、计划、地点或事件。</p><button type="submit" disabled={busy || !dirty}>{busy ? '正在保存…' : '保存联系边界'}</button></form>}</section>;
}
```

Import the completed form in `LifeObservationPanel.tsx` and render it after `LifeObservationDetails`:

```tsx
import { LifeContactBoundaryForm } from './LifeContactBoundaryForm.js';

<LifeContactBoundaryForm initial={data.settings} onNotice={onNotice} />
```

At the same time, change the Task 2 destructuring from `onNotice: _onNotice` to `onNotice`, because the prop is now used by the form.

- [ ] **Step 4: Verify the form and polling interaction**

Extend `LifeObservationPanel.test.tsx` so a 30-second refresh supplies new server settings while an edited boundary draft remains unchanged. This proves the coordinator does not remount the form.

- [ ] **Step 5: Run focused tests and typecheck**

```powershell
npm test -w @sooya/web -- src/components/life/LifeContactBoundaryForm.test.tsx src/components/life/LifeObservationPanel.test.tsx
npm run typecheck -w @sooya/web
```

Expected: all focused tests PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

```powershell
git add packages/web/src/components/life/LifeContactBoundaryForm.tsx packages/web/src/components/life/LifeContactBoundaryForm.test.tsx packages/web/src/components/life/LifeObservationPanel.tsx
git commit -m "feat(life): keep contact boundaries editable"
```

## Task 5: Integrate the single page and remove the duplicate console

**Files:**

- Modify: `packages/web/src/components/AdminPanel.tsx`
- Modify: `packages/web/src/components/FeatureAdminPage.tsx`
- Modify: `packages/web/src/AppShell.tsx`
- Modify: `packages/web/src/AppShell.test.tsx`
- Modify: `packages/web/src/components/adminConsole.test.ts`
- Delete: `packages/web/src/components/LifeAdminPage.tsx`
- Delete: `packages/web/src/components/LifeAdminPage.test.tsx`

- [ ] **Step 1: Write failing single-shell route contracts**

In `AppShell.test.tsx`, mount `/admin/life/console` and assert the single mocked `AdminPanel` renders. In `adminConsole.test.ts`, change the life import expectations to:

```ts
expect(PANEL).toContain("import { LifeObservationPanel } from './life/LifeObservationPanel.js'");
expect(PANEL).toContain("tab === 'life'");
expect(PANEL).toContain('<LifeObservationPanel onNotice={setNotice} />');
expect(PANEL).not.toContain('LifeAdminLink');
expect(EDITORS).not.toContain('export function LifePanel(');
expect(EDITORS).not.toContain('export function LifeAdminLink(');
expect(SHELL).not.toContain('LifeAdminPage');
expect(SHELL).not.toContain('isLifeConsole');
```

- [ ] **Step 2: Run the route/console tests and verify red**

```powershell
npm test -w @sooya/web -- src/AppShell.test.tsx src/components/adminConsole.test.ts
```

Expected: FAIL because the old console branch and old embedded panel still exist.

- [ ] **Step 3: Replace the life branch in `AdminPanel.tsx`**

Import `LifeObservationPanel` directly and replace:

```tsx
tab === 'life'
  ? <><LifeAdminLink /><LifePanel onNotice={setNotice} /></>
```

with:

```tsx
tab === 'life'
  ? <LifeObservationPanel onNotice={setNotice} />
```

Remove `LifeAdminLink` and `LifePanel` from the `FeatureAdminPage` import.

- [ ] **Step 4: Remove the old embedded implementation**

Delete `LifeAdminLink`, `LifePanel`, `EmptyLife`, `lifePlanStatusText`, and life-only imports/state from `FeatureAdminPage.tsx`. Keep avatar, voice, reference, and storage editors unchanged.

- [ ] **Step 5: Collapse `AppShell` to one admin renderer**

Remove the `LifeAdminPage` import, path state, navigation listeners, and `isLifeConsole`. The admin branch becomes:

```tsx
{route === 'admin' && <AdminPanel />}
```

Because `tabFromAdminPath('/admin/life/console')` already returns `life`, `AdminPanel`'s canonical-path effect will replace the old URL with `/admin/life`.

- [ ] **Step 6: Delete the standalone console and its test**

Delete `LifeAdminPage.tsx` and `LifeAdminPage.test.tsx` only after all used read-only display logic has been moved into the new observation components.

- [ ] **Step 7: Run route, component, and type checks**

```powershell
npm test -w @sooya/web -- src/AppShell.test.tsx src/components/adminConsole.test.ts src/components/FeatureAdminPage.test.tsx src/components/life
npm run typecheck -w @sooya/web
```

Expected: all selected tests PASS; typecheck exits 0; no import references `LifeAdminPage`, `LifeAdminLink`, or the old `LifePanel`.

- [ ] **Step 8: Commit**

```powershell
git add packages/web/src/AppShell.tsx packages/web/src/AppShell.test.tsx packages/web/src/components/AdminPanel.tsx packages/web/src/components/FeatureAdminPage.tsx packages/web/src/components/FeatureAdminPage.test.tsx packages/web/src/components/adminConsole.test.ts packages/web/src/components/LifeAdminPage.tsx packages/web/src/components/LifeAdminPage.test.tsx packages/web/src/components/life
git commit -m "refactor(life): unify admin observation page"
```

## Task 6: Apply the flat responsive visual system and update browser tests

**Files:**

- Modify: `packages/web/src/components/AdminPanel.css`
- Modify: `packages/web/src/styles.css`
- Modify: `packages/web/src/components/styleTokens.test.ts`
- Modify: `e2e/mobile-admin-ux.e2e.ts`
- Modify: `e2e/next-phase.e2e.ts`

- [ ] **Step 1: Replace obsolete CSS contract tests**

Remove assertions for `.life-rules` and add these contracts:

```ts
expect(ADMIN).toMatch(/\.life-observation\s*\{[^}]*max-width:\s*880px/s);
expect(ADMIN).toMatch(/\.life-preview-row\s*\{[^}]*border-bottom:/s);
expect(ADMIN).toMatch(/\.life-disclosure-toggle\s*\{[^}]*min-height:\s*44px/s);
expect(ADMIN).toMatch(/@media \(max-width:\s*640px\)[\s\S]*\.life-boundary-form/s);
expect(ADMIN).not.toMatch(/\.life-observation[^}]*box-shadow:/s);
```

- [ ] **Step 2: Run the token test and verify red**

```powershell
npm test -w @sooya/web -- src/components/styleTokens.test.ts
```

Expected: FAIL until the new flat layout exists.

- [ ] **Step 3: Add the flat layout CSS**

Add semantic classes to `AdminPanel.css` using existing variables rather than raw theme colors:

```css
.admin-v2 .life-observation {
  width: 100%;
  max-width: 880px;
  margin: 0 auto;
  color: var(--admin-text);
}

.admin-v2 .life-observation-heading,
.admin-v2 .life-now-summary,
.admin-v2 .life-preview,
.admin-v2 .life-threads-preview {
  padding: 24px 0;
  border-bottom: 1px solid var(--admin-line);
}

.admin-v2 .life-observation-heading { padding-top: 0; }
.admin-v2 .life-observation-heading p,
.admin-v2 .life-observation-heading small,
.admin-v2 .life-now-summary > p,
.admin-v2 .life-section-heading span,
.admin-v2 .life-preview-row span,
.admin-v2 .life-disclosure-toggle small { color: var(--admin-muted); }

.admin-v2 .life-preview-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 52px;
  border-bottom: 1px solid var(--admin-line);
}

.admin-v2 .life-disclosure { border-bottom: 1px solid var(--admin-line); }
.admin-v2 .life-disclosure-toggle {
  display: flex;
  width: 100%;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  padding: 18px 0;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  box-shadow: none;
}
.admin-v2 .life-disclosure-toggle > span:first-child { display: grid; gap: 4px; }
.admin-v2 .life-disclosure-panel { padding: 0 0 24px; }

.admin-v2 .life-boundary-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.admin-v2 .life-boundary-form > p,
.admin-v2 .life-boundary-form > button,
.admin-v2 .life-boundary-form > fieldset { grid-column: 1 / -1; }

@media (max-width: 640px) {
  .admin-v2 .life-observation { max-width: 100%; overflow-x: clip; }
  .admin-v2 .life-preview-row { align-items: flex-start; flex-direction: column; gap: 4px; padding: 14px 0; }
  .admin-v2 .life-boundary-form { grid-template-columns: 1fr; }
  .admin-v2 .life-boundary-form > * { grid-column: 1; min-width: 0; }
}
```

Use the existing `.life-progress` token-driven bar, but remove old `.life-rules`, `.life-plan-create`, and old embedded card overrides that are no longer referenced.

- [ ] **Step 4: Remove standalone-console CSS**

From `styles.css`, remove selectors used only by the deleted `LifeAdminPage`: `.admin-tabs`, `.life-overview`, `.weather-grid`, `.weather-card`, `.weather-kv`, `.weather-actions`, `.forecast-*`, and their standalone-console mobile rules. Before deletion, confirm with `rg` that no remaining TSX file references each class.

- [ ] **Step 5: Update the 375px E2E contract**

Replace the old life-rules/add-plan assertions in `mobile-admin-ux.e2e.ts` with:

```ts
await page.goto('/admin/life');
const observation = page.getByTestId('life-observation');
await expect(observation).toBeVisible();
await expect(page.getByRole('button', { name: '添加计划' })).toHaveCount(0);
await expect(page.getByRole('button', { name: '立即推进' })).toHaveCount(0);
await page.getByRole('button', { name: /联系边界/ }).click();
const boundaries = page.getByTestId('life-boundaries');
await expect(boundaries.getByRole('button', { name: '保存联系边界' })).toBeVisible();
expect(await observation.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
```

- [ ] **Step 6: Update the old-console E2E contract**

In `next-phase.e2e.ts`, keep `/admin/life/console` as the entry to prove compatibility, then assert canonicalization and lazy environment display:

```ts
await gotoAdmin(page, '/admin/life/console');
await expect(page).toHaveURL(/\/admin\/life$/);
await expect(page.getByTestId('life-observation')).toBeVisible();
await page.getByRole('button', { name: /地点与天气/ }).click();
await expect(page.getByTestId('life-environment-detail')).toContainText('家');
```

Keep the direct city API test unchanged because backend mutation APIs are explicitly retained. Change only its final page assertion from `life-admin-page` to `life-observation` plus the canonical URL.

- [ ] **Step 7: Run CSS, focused component, and E2E tests**

```powershell
npm test -w @sooya/web -- src/components/styleTokens.test.ts src/components/life src/AppShell.test.tsx src/components/adminConsole.test.ts
npm run typecheck -w @sooya/web
npm run test:e2e -- mobile-admin-ux.e2e.ts next-phase.e2e.ts
```

Expected: Vitest PASS, typecheck exits 0, and both E2E files pass in desktop/mobile projects with the mobile-only test skipped in desktop as designed.

- [ ] **Step 8: Commit**

```powershell
git add packages/web/src/components/AdminPanel.css packages/web/src/styles.css packages/web/src/components/styleTokens.test.ts e2e/mobile-admin-ux.e2e.ts e2e/next-phase.e2e.ts
git commit -m "style(life): flatten autonomous observation page"
```

## Task 7: Full regression and visual evidence

**Files:**

- Verify only; do not modify unrelated files.

- [ ] **Step 1: Verify prohibited UI/API calls are absent from the page code**

```powershell
rg -n "tickLife|createLifePlan|updateLifePlan|adjustVitals|resetVitals|updateThread|overrideLocation|createLocation|deleteLocation|updateCity" packages/web/src/components/life
```

Expected: no matches.

- [ ] **Step 2: Run the full web unit suite**

```powershell
npm test -w @sooya/web
```

Expected: all web Vitest files PASS with zero failures.

- [ ] **Step 3: Run repository typecheck and web build**

```powershell
npm run typecheck
npm run build -w @sooya/web
```

Expected: both commands exit 0.

- [ ] **Step 4: Run the relevant real-browser suites**

```powershell
npm run test:e2e -- mobile-admin-ux.e2e.ts next-phase.e2e.ts navigation.e2e.ts
```

Expected: all selected desktop/mobile tests PASS; the mobile-specific test is skipped only in the desktop project.

- [ ] **Step 5: Capture desktop and mobile evidence**

With the E2E server running, open `/admin/life` at 1280×860 and 375×812. Verify and capture:

- one continuous flat content surface rather than cards for each block;
- no horizontal inner tab bar;
- no intervention controls;
- readable collapsed sections;
- contact-boundary form fits at 375px;
- old `/admin/life/console` canonicalizes to `/admin/life`.

Save screenshots under the active test output directory rather than adding generated images to git.

- [ ] **Step 6: Inspect the final diff and working tree**

```powershell
git diff --check
git status --short
git log --oneline -7
```

Expected: no whitespace errors; only intended task files are changed or committed; pre-existing untracked files remain untouched.

- [ ] **Step 7: Commit any verification-only test adjustment if one was required**

If Step 2–5 required a test-only correction, stage only that correction and commit it:

```powershell
git add packages/web/src e2e
git commit -m "test(life): verify autonomous observation page"
```

If no correction was required, do not create an empty commit.
