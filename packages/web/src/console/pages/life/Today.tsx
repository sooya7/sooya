import { useState, type ReactNode } from 'react';
import { adminApi, type AdminLifePlan, type AdminLifeThread, type AdminLifeVitals } from '../../../lib/admin.js';
import { featureApi, type LifePanelData, type LifePlanStatus } from '../../../lib/features.js';
import { lifeKindLabel } from '../../../lib/lifeObservation.js';
import { herClock, slotProgress } from '../../../lib/lifeView.js';
import { weatherConditionLabel } from '../../../lib/worldDisplay.js';
import { formatTemperature } from '../../../lib/numberDisplay.js';
import {
  Button, Callout, ConfirmButton, Empty, Facts, Field, Fields, Input, Loadable, Meter, Section, Select, Tag,
  fmtAgo, useAction, useLoad,
  DateTimePicker } from '../../ui.js';
import {
  PLAN_KINDS, PLAN_SOURCE, planStatusLabel, THREAD_STATUS, TRAVEL_MODE, VITALS, browserDiffers, fraction, fromHerInput, herDay, herRange,
  herToday, herWhen, parseJsonArray, threadCategoryLabel, toHerInput, useLife, vitalTone, vitalsScale
} from './shared.js';

export function TodayTab({ panel }: { panel: LifePanelData }) {
  return (
    <>
      <NowSection panel={panel} />
      <TimelineSection panel={panel} />
      <VitalsSection />
      <PlansSection />
      <ThreadsSection />
    </>
  );
}

/* --------------------------------------------------------------- right now */

function NowSection({ panel }: { panel: LifePanelData }) {
  const { version, pulse, refresh, tz } = useLife();
  const { run, busy } = useAction();
  const env = useLoad(async () => {
    const [overview, travel, locations, weather, cities] = await Promise.allSettled([
      adminApi.lifeOverview(), adminApi.lifeTravel(), adminApi.lifeLocations(), adminApi.weatherStatus(), adminApi.lifeCities()
    ]);
    return {
      overview: overview.status === 'fulfilled' ? overview.value : null,
      travel: travel.status === 'fulfilled' ? travel.value.travel : null,
      locations: locations.status === 'fulfilled' ? locations.value : null,
      weather: weather.status === 'fulfilled' ? weather.value : null,
      cities: cities.status === 'fulfilled' ? cities.value.cities : []
    };
  }, [version, pulse]);

  const snap = panel.snapshot;
  const progress = slotProgress(snap);
  const overview = env.data?.overview ?? null;
  const current = env.data?.locations?.current ?? null;
  const cityName = (current?.cityId && env.data?.cities.find((c) => c.id === current.cityId)?.name) || current?.city || null;
  const travel = env.data?.travel ?? null;
  const placeName = (id: string) => env.data?.locations?.locations.find((l) => l.id === id)?.name ?? '另一个地方';
  const snapWeather = env.data?.weather?.lastSnapshot ?? null;
  const weatherText = snapWeather
    ? [weatherConditionLabel(snapWeather.condition), snapWeather.temperatureC == null ? null : formatTemperature(snapWeather.temperatureC)].filter(Boolean).join('，')
    : overview?.weather ? weatherConditionLabel(overview.weather) : '还没取到';

  const tick = async () => {
    const result = await run('tick', () => featureApi.tickLife());
    if (!result) return;
    refresh();
    return result;
  };

  return (
    <Section
      defaultOpen
      title="她现在"
      desc="比顶部那一条更细：这段活动进行到哪、今天过的是什么样的一天、人在哪。"
    >
      <p className="cs-her-quote">
        {snap.activity ? `${snap.activity.replace(/[。.]$/, '')}。` : '现在没有具体在做的事。'}
        {snap.mood ? `心情${snap.mood}。` : ''}
      </p>
      <div className="life-now-progress">
        <Meter label="这一段" value={progress.percent / 100} display={`${progress.percent}%`} />
        <span className="cs-muted">
          {herClock(snap.startedAt, tz)} 开始，{herClock(snap.endsAt, tz)} 结束；已经 {progress.intoIt}，还剩 {progress.left}
        </span>
      </div>
      <Facts items={[
        ['在做的是', lifeKindLabel(snap.kind)],
        ['今天过的是', overview?.snapshot.theme ?? (snap as { theme?: string }).theme ?? '还没定'],
        ['人在', current ? [cityName, current.name].filter(Boolean).join('，') : overview?.location?.name ?? '没有设定地点'],
        ['路上', travel ? `正${TRAVEL_MODE[travel.mode] ? TRAVEL_MODE[travel.mode] : ''}去${placeName(travel.toLocationId)}，预计 ${herWhen(travel.expectedArriveAt, tz)} 到` : '没在路上'],
        ['天气', weatherText],
        ['正在做的计划', overview?.activePlan?.title ?? '没有']
      ]} />
      {!!env.error && !env.data && <Callout tone="warn">地点和天气这一块没读到，其余照常。</Callout>}
      <div className="cs-actions">
        <TickButton busy={busy === 'tick'} onTick={tick} />
        <Button kind="text" size="sm" busy={env.loading && !!env.data} onClick={refresh}>刷新</Button>
      </div>
    </Section>
  );
}

function TickButton({ busy, onTick }: { busy: boolean; onTick: () => Promise<unknown> }) {
  const [last, setLast] = useState<string | null>(null);
  return (
    <>
      <Button kind="quiet" busy={busy} onClick={async () => {
        const result = (await onTick()) as { changed: boolean; activity: string } | undefined;
        if (result) setLast(result.changed ? `推进好了，换成了新的活动：${result.activity}。` : `推进好了，按现在的时间还是“${result.activity}”，没有变化。`);
      }}>推进一次生活模拟</Button>
      <span className="cs-muted life-hint">{last ?? '平时会自己定时推进。手动推进只是让她立刻按当前时间结算一次，不调用模型，不消耗额度。'}</span>
    </>
  );
}

/* ---------------------------------------------------------------- timeline */

interface Entry {
  key: string;
  start: string | null;
  end: string | null;
  title: string;
  meta: string;
  state: 'done' | 'now' | 'next';
  tag?: ReactNode;
}

function TimelineSection({ panel }: { panel: LifePanelData }) {
  const { tz } = useLife();
  const today = herToday(tz);
  const isToday = (iso: string | null | undefined) => herDay(iso, tz) === today;
  const snap = panel.snapshot;
  const seen = new Set<string>();
  const entries: Entry[] = [];

  for (const row of panel.log) {
    if (!isToday(row.started_at) && !isToday(row.ended_at)) continue;
    seen.add(`${row.activity}@${row.started_at}`);
    entries.push({
      key: `log-${row.id}`, start: row.started_at, end: row.ended_at, title: row.activity,
      meta: [lifeKindLabel(row.kind), row.mood ? `心情${row.mood}` : null].filter(Boolean).join('，'),
      state: 'done', tag: row.shared ? <Tag tone="ok">分享过</Tag> : undefined
    });
  }
  for (const item of snap.recent ?? []) {
    if (!isToday(item.startedAt) || seen.has(`${item.activity}@${item.startedAt}`)) continue;
    entries.push({ key: `recent-${item.startedAt}`, start: item.startedAt, end: item.endedAt, title: item.activity, meta: '', state: 'done' });
  }
  entries.push({
    key: 'now', start: snap.startedAt, end: snap.endsAt, title: snap.activity,
    meta: [lifeKindLabel(snap.kind), snap.mood ? `心情${snap.mood}` : null].filter(Boolean).join('，'),
    state: 'now', tag: <Tag tone="ok">现在</Tag>
  });
  const nowMs = Date.now();
  for (const plan of panel.plans) {
    if (!['planned', 'active', 'paused'].includes(plan.status) || !isToday(plan.planned_start)) continue;
    if (plan.status !== 'active' && Date.parse(plan.planned_end ?? plan.planned_start ?? '') < nowMs) continue;
    entries.push({
      key: `plan-${plan.id}`, start: plan.planned_start, end: plan.planned_end, title: plan.title,
      meta: `计划，${planStatusLabel(plan.status)}`, state: 'next'
    });
  }
  entries.sort((a, b) => (Date.parse(a.start ?? '') || 0) - (Date.parse(b.start ?? '') || 0));

  return (
    <Section title="今天的时间线" desc="她今天已经做过的、正在做的，和后面可能会做的。时间按她那边的钟点。">
      <ol className="life-timeline">
        {entries.map((entry) => (
          <li key={entry.key} className="life-timeline-item" data-state={entry.state}>
            <span className="life-timeline-time">{herRange(entry.start, entry.end, tz)}</span>
            <span className="life-timeline-text">
              <span className="life-timeline-title">{entry.title}</span>
              {entry.tag}
              {entry.meta && <span className="cs-list-meta">{entry.meta}</span>}
            </span>
          </li>
        ))}
      </ol>
      {!entries.some((e) => e.state === 'done') && <p className="cs-muted">今天更早的部分还没有记录。生活模拟推进之后，做完的事会一条条留在这里。</p>}
    </Section>
  );
}

/* ------------------------------------------------------------------ vitals */

function VitalsSection() {
  const { version, pulse } = useLife();
  const { run, busy } = useAction();
  const state = useLoad(() => adminApi.lifeVitals(), [version, pulse]);
  const [step, setStep] = useState('10');

  const adjust = async (field: string, delta: number, label: string) => {
    const result = await run(`adjust-${field}`, () => adminApi.adjustVitals(field, delta), `${label}已${delta > 0 ? '调高' : '调低'} ${Math.abs(delta)}`);
    if (result) state.setData({ vitals: result.vitals });
  };
  const reset = async () => {
    const ok = await run('reset', () => adminApi.resetVitals(), '数值已恢复默认');
    if (ok) await state.reload();
  };

  return (
    <Section
      title="身体和情绪"
      desc="这些数值会随作息自己变化，也会影响她说话的状态。调整只是轻推一下，之后仍会按生活节律继续变化。"
    >
      <Loadable state={state} label="身体数值">
        {({ vitals }) => {
          if (!vitals) {
            return (
              <Empty action={<Button kind="quiet" size="sm" busy={busy === 'reset'} onClick={() => void reset()}>生成一组默认数值</Button>}>
                还没有身体数值。生成一组默认值后就能看到和调整。
              </Empty>
            );
          }
          const scale = vitalsScale(vitals);
          const updated = (vitals as AdminLifeVitals & { updated_at?: string }).updated_at;
          return (
            <>
              <div className="life-vitals" data-no-dirty>
                {VITALS.map(({ key, label, direction, hint }) => {
                  const value = Math.max(0, Math.min(1, Number(vitals[key] ?? 0) / scale));
                  const delta = Number(step);
                  return (
                    <div className="life-vital" key={key}>
                      <Meter label={label} value={value} tone={vitalTone(value, direction)} />
                      <span className="life-vital-actions">
                        <Button kind="text" size="sm" aria-label={`${label}调低 ${delta}`} busy={busy === `adjust-${key}`} disabled={value <= 0} onClick={() => void adjust(key, -delta, label)}>－{delta}</Button>
                        <Button kind="text" size="sm" aria-label={`${label}调高 ${delta}`} busy={busy === `adjust-${key}`} disabled={value >= 1} onClick={() => void adjust(key, delta, label)}>＋{delta}</Button>
                      </span>
                      <span className="life-vital-hint">{hint}</span>
                    </div>
                  );
                })}
                <SleepDebt hours={Number(vitals.sleep_debt ?? 0)} />
              </div>
              <div className="cs-actions life-vitals-foot" data-no-dirty>
                <label className="life-inline-field">
                  <span className="cs-muted">每次调</span>
                  <Select value={step} onChange={(e) => setStep(e.target.value)} options={[
                    { value: '5', label: '5 点' }, { value: '10', label: '10 点' }, { value: '20', label: '20 点' }
                  ]} />
                </label>
                <ConfirmButton
                  label="恢复默认数值"
                  question="所有数值都回到默认，包括缺觉。确定吗？"
                  confirmLabel="恢复默认"
                  busy={busy === 'reset'}
                  onConfirm={reset}
                />
                {updated && <span className="cs-muted life-hint">上次变化在 {fmtAgo(updated)}</span>}
              </div>
            </>
          );
        }}
      </Loadable>
    </Section>
  );
}

function SleepDebt({ hours }: { hours: number }) {
  const h = Number.isFinite(hours) ? Math.max(0, hours) : 0;
  const tone = h >= 6 ? 'bad' : h >= 4 ? 'warn' : undefined;
  return (
    <div className="life-vital">
      <Meter label="缺觉（小时）" value={Math.min(1, h / 8)} tone={tone} display={String(Math.round(h * 10) / 10)} />
      <span className="life-vital-actions" />
      <span className="life-vital-hint">只会随作息变化，不能手动调；满 8 小时算很缺。恢复默认会回到 1.5 小时。</span>
    </div>
  );
}

/* ------------------------------------------------------------------- plans */

type PlanRow = AdminLifePlan & { created_at?: string };

const OPEN_STATUSES = ['active', 'planned', 'paused'];

const PLAN_MOVES: Record<string, Array<{ to: LifePlanStatus; label: string; done: string }>> = {
  planned: [
    { to: 'active', label: '现在就做', done: '她开始做这件事了' },
    { to: 'paused', label: '先放一放', done: '这个计划先放一放了' },
    { to: 'cancelled', label: '不做了', done: '这个计划不做了' }
  ],
  active: [
    { to: 'completed', label: '做完了', done: '这个计划做完了' },
    { to: 'paused', label: '暂停', done: '这个计划暂停了' },
    { to: 'cancelled', label: '不做了', done: '这个计划不做了' }
  ],
  paused: [
    { to: 'active', label: '继续做', done: '她继续做这件事了' },
    { to: 'cancelled', label: '不做了', done: '这个计划不做了' }
  ],
  cancelled: [{ to: 'planned', label: '重新安排', done: '这个计划重新安排上了' }],
  skipped: [{ to: 'planned', label: '重新安排', done: '这个计划重新安排上了' }],
  completed: []
};

function planTone(status: string): 'ok' | 'warn' | undefined {
  return status === 'active' ? 'ok' : status === 'paused' ? 'warn' : undefined;
}

function PlansSection() {
  const { version, refresh, tz } = useLife();
  const { run, busy } = useAction();
  const state = useLoad(() => adminApi.lifePlans(), [version]);
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const move = async (plan: PlanRow, to: LifePlanStatus, done: string) => {
    const result = await run(`plan-${plan.id}`, () => featureApi.updateLifePlan(plan.id, { status: to }), done);
    if (result) refresh();
  };

  return (
    <Section title="计划" desc="她打算做的事。大多是她按当天的主题自己排的，你也可以替她加一件，或者改掉、叫停。做完的计划会保留原样，不能再改。">
      <Loadable state={state} label="计划">
        {({ plans: raw }) => {
          const plans = raw as PlanRow[];
          const byTime = (a: PlanRow, b: PlanRow) => (Date.parse(a.planned_start ?? a.created_at ?? '') || Infinity) - (Date.parse(b.planned_start ?? b.created_at ?? '') || Infinity);
          const open = plans.filter((p) => OPEN_STATUSES.includes(p.status)).sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || byTime(a, b));
          const closed = plans.filter((p) => !OPEN_STATUSES.includes(p.status)).sort((a, b) => -byTime(a, b));
          const renderPlan = (plan: PlanRow) => (
            <div className="cs-list-item" key={plan.id}>
              <span>
                <span className="cs-list-title">{plan.title}</span>{' '}
                <Tag tone={planTone(plan.status)}>{planStatusLabel(plan.status)}</Tag>
              </span>
              <span className="cs-list-side">
                {(PLAN_MOVES[plan.status] ?? []).map((m) => (
                  <Button key={m.to} kind="text" size="sm" busy={busy === `plan-${plan.id}`} onClick={() => void move(plan, m.to, m.done)}>{m.label}</Button>
                ))}
                {plan.status !== 'completed' && (
                  <Button kind="text" size="sm" onClick={() => setEditing(editing === plan.id ? null : plan.id)}>{editing === plan.id ? '收起' : '修改'}</Button>
                )}
              </span>
              <span className="cs-list-meta">
                {[herRange(plan.planned_start, plan.planned_end, tz), lifeKindLabel(plan.kind), PLAN_SOURCE[plan.source] ?? plan.source].join('，')}
              </span>
              {editing === plan.id && (
                <div className="cs-list-body">
                  <PlanForm plan={plan} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />
                </div>
              )}
            </div>
          );
          return (
            <>
              {open.length ? <div className="cs-list life-stack">{open.map(renderPlan)}</div> : (
                <Empty>她现在没有排着的计划。生活模拟推进时她会按当天的主题排一些，你也可以在下面替她加一件。</Empty>
              )}
              {closed.length > 0 && (
                <div data-no-dirty>
                  <Button kind="text" size="sm" onClick={() => setShowClosed((v) => !v)}>
                    {showClosed ? '收起已结束的计划' : `看已结束的 ${closed.length} 个计划`}
                  </Button>
                  {showClosed && <div className="cs-list life-stack life-closed">{closed.map(renderPlan)}</div>}
                </div>
              )}
            </>
          );
        }}
      </Loadable>
      <div className="life-subform">
        <h3 className="life-subhead">替她加一个计划</h3>
        <PlanForm onDone={refresh} />
      </div>
    </Section>
  );
}

function PlanForm({ plan, onDone, onCancel }: { plan?: PlanRow; onDone: () => void; onCancel?: () => void }) {
  const { tz, touch, settle } = useLife();
  const { run, busy } = useAction();
  const key = plan ? `plan-edit-${plan.id}` : 'plan-new';
  const [title, setTitle] = useState(plan?.title ?? '');
  const [kind, setKind] = useState(plan?.kind ?? 'task');
  const [start, setStart] = useState(toHerInput(plan?.planned_start, tz));
  const [end, setEnd] = useState(toHerInput(plan?.planned_end, tz));
  const [error, setError] = useState<string | null>(null);
  const kinds = PLAN_KINDS.some((k) => k.value === kind) ? PLAN_KINDS : [...PLAN_KINDS, { value: kind, label: lifeKindLabel(kind) }];
  const zoneHint = browserDiffers(tz) ? '按她那边的时间填（她在东八区）。' : undefined;

  const change = <T,>(set: (v: T) => void) => (v: T) => { set(v); touch(key); setError(null); };

  const submit = async () => {
    if (!title.trim()) { setError('写一下要做什么。'); return; }
    const plannedStart = fromHerInput(start, tz);
    const plannedEnd = fromHerInput(end, tz);
    if (plannedStart && plannedEnd && plannedEnd <= plannedStart) { setError('结束时间要晚于开始时间。'); return; }
    const body = { title: title.trim(), kind, plannedStart, plannedEnd };
    const result = plan
      ? await run(key, () => featureApi.updateLifePlan(plan.id, body), '计划已修改')
      : await run(key, () => featureApi.createLifePlan(body), '计划已加上');
    if (!result) return;
    settle(key);
    if (!plan) { setTitle(''); setStart(''); setEnd(''); }
    onDone();
  };

  return (
    <div className="life-form">
      <Fields>
        <Field label="要做什么" error={error}>
          <Input value={title} maxLength={200} placeholder="比如：下午去图书馆还书" onChange={(e) => change(setTitle)(e.target.value)} />
        </Field>
        <Field label="是哪类事">
          <Select value={kind} options={kinds} onChange={(e) => change(setKind)(e.target.value)} />
        </Field>
        <Field label="打算几点开始" hint={zoneHint ?? '可以不填。'}>
          <DateTimePicker label="开始" value={start} offsetMinutes={tz} onChange={change(setStart)} />
        </Field>
        <Field label="打算几点结束" hint="可以不填。">
          <DateTimePicker label="结束" value={end} offsetMinutes={tz} onChange={change(setEnd)} />
        </Field>
      </Fields>
      <div className="cs-actions">
        <Button size="sm" busy={busy === key} onClick={() => void submit()}>{plan ? '保存这个计划' : '加上这个计划'}</Button>
        {onCancel && <Button kind="text" size="sm" onClick={() => { settle(key); onCancel(); }}>取消</Button>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- threads */

const THREAD_MOVES: Record<string, Array<{ to: string; label: string; done: string }>> = {
  open: [
    { to: 'paused', label: '先不想了', done: '这件事先放下了' },
    { to: 'resolved', label: '已经了结', done: '这件事了结了' },
    { to: 'abandoned', label: '不再想了', done: '这件事不再惦记了' }
  ],
  paused: [
    { to: 'open', label: '重新惦记', done: '她又惦记起这件事了' },
    { to: 'resolved', label: '已经了结', done: '这件事了结了' },
    { to: 'abandoned', label: '不再想了', done: '这件事不再惦记了' }
  ],
  resolved: [{ to: 'open', label: '重新惦记', done: '她又惦记起这件事了' }],
  abandoned: [{ to: 'open', label: '重新惦记', done: '她又惦记起这件事了' }]
};

type ThreadRow = AdminLifeThread & { updated_at?: string; last_advanced_at?: string | null };

function ThreadsSection() {
  const { version, refresh } = useLife();
  const { run, busy } = useAction();
  const state = useLoad(() => adminApi.lifeThreads(), [version]);
  const [showClosed, setShowClosed] = useState(false);

  const move = async (thread: ThreadRow, to: string, done: string) => {
    const result = await run(`thread-${thread.id}`, () => adminApi.updateThread(thread.id, to), done);
    if (result) refresh();
  };

  return (
    <Section title="她惦记的事" desc="一段时间里会反复想起、慢慢推进的事，比如在学的东西、答应过的事。惦记得越多，聊天时越容易提起。">
      <Loadable state={state} label="惦记的事">
        {({ threads: raw }) => {
          const threads = raw as ThreadRow[];
          const live = threads.filter((t) => t.status === 'open' || t.status === 'paused')
            .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || fraction(b.heat) - fraction(a.heat));
          const closed = threads.filter((t) => t.status !== 'open' && t.status !== 'paused');
          const renderThread = (thread: ThreadRow) => {
            const next = parseJsonArray(thread.next_actions_json);
            return (
              <div className="cs-list-item" key={thread.id}>
                <span>
                  <span className="cs-list-title">{thread.title}</span>{' '}
                  <Tag tone={thread.status === 'open' ? 'ok' : undefined}>{THREAD_STATUS[thread.status] ?? thread.status}</Tag>
                </span>
                <span className="cs-list-side">
                  {(THREAD_MOVES[thread.status] ?? []).map((m) => (
                    <Button key={m.to} kind="text" size="sm" busy={busy === `thread-${thread.id}`} onClick={() => void move(thread, m.to, m.done)}>{m.label}</Button>
                  ))}
                </span>
                <span className="cs-list-meta">
                  {[
                    threadCategoryLabel(thread.category),
                    `进度 ${Math.round(fraction(thread.progress) * 100)}%`,
                    `最近想起的程度 ${Math.round(fraction(thread.heat) * 100)}%`,
                    thread.last_advanced_at ? `上次推进在 ${fmtAgo(thread.last_advanced_at)}` : null
                  ].filter(Boolean).join('，')}
                </span>
                {next.length > 0 && <span className="cs-list-body">接下来可能会：{next.join('；')}</span>}
              </div>
            );
          };
          return (
            <>
              {live.length ? <div className="cs-list life-stack">{live.map(renderThread)}</div> : (
                <Empty>她现在没有惦记的事。聊天里答应过的事、感兴趣的东西，会在生活模拟推进时慢慢变成这里的一条。</Empty>
              )}
              {closed.length > 0 && (
                <div data-no-dirty>
                  <Button kind="text" size="sm" onClick={() => setShowClosed((v) => !v)}>
                    {showClosed ? '收起已经放下的' : `看已经放下的 ${closed.length} 件`}
                  </Button>
                  {showClosed && <div className="cs-list life-stack life-closed">{closed.map(renderThread)}</div>}
                </div>
              )}
            </>
          );
        }}
      </Loadable>
    </Section>
  );
}

