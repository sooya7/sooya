import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api.js';
import { useAutoNotice } from '../lib/autoNotice.js';
import { AppLink } from './AppLink.js';
import {
  adminApi,
  type AdminLifeLocation,
  type AdminLifePlan,
  type AdminLifeThread,
  type AdminLifeVitals,
  type AdminProactiveAttempt,
  type LifeCity,
  type TravelState,
  type WeatherCondition,
  type WeatherForecastPeriod,
  type WeatherStatus
} from '../lib/admin.js';
import { AdminState, adminStateFromError } from './admin/AdminState.js';
import { ConfirmDialog } from './admin/ConfirmDialog.js';
import { DataList } from './admin/DataList.js';

type Section = 'overview' | 'vitals' | 'plans' | 'threads' | 'events' | 'locations' | 'proactive' | 'weather';

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'vitals', label: 'Vitals' },
  { key: 'plans', label: 'Plans' },
  { key: 'threads', label: 'Threads' },
  { key: 'events', label: 'Events' },
  { key: 'locations', label: 'Locations' },
  { key: 'proactive', label: 'Proactive' },
  { key: 'weather', label: 'Weather' }
];

/**
 * Life Admin console (next phase P1): a complete management surface for the
 * life system. Admin mutations go through the audited API; the admin cannot
 * bypass the ReplyCoordinator or rewrite completed history.
 */
export default function LifeAdminPage() {
  const [section, setSection] = useState<Section>('overview');
  const tabRefs = useRef<Partial<Record<Section, HTMLButtonElement | null>>>({});
  useEffect(() => {
    // On mobile the strip scrolls; keep the active tab visible.
    tabRefs.current[section]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [section]);
  return (
    <div className="admin-page" data-testid="life-admin-page">
      <header className="admin-header">
        <div className="admin-header-row">
          <h1>Life 管理中心</h1>
          <AppLink className="admin-back" href="/admin/features" aria-label="返回功能中心">‹ 返回</AppLink>
        </div>
        <nav className="admin-tabs" aria-label="Life 管理分区" role="tablist">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              ref={(node) => { tabRefs.current[s.key] = node; }}
              type="button"
              role="tab"
              id={`life-tab-${s.key}`}
              aria-selected={section === s.key}
              aria-controls={`life-panel-${s.key}`}
              className={section === s.key ? 'admin-tab active' : 'admin-tab'}
              onClick={() => setSection(s.key)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </header>
      <div role="tabpanel" id={`life-panel-${section}`} aria-labelledby={`life-tab-${section}`}>
        {section === 'overview' && <OverviewSection />}
        {section === 'vitals' && <VitalsSection />}
        {section === 'plans' && <PlansSection />}
        {section === 'threads' && <ThreadsSection />}
        {section === 'events' && <EventsSection />}
        {section === 'locations' && <LocationsSection />}
        {section === 'proactive' && <ProactiveSection />}
        {section === 'weather' && <WeatherSection />}
      </div>
    </div>
  );
}

function useAdmin<T>(load: () => Promise<T>): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    load()
      .then((value) => { if (alive) setData(value); })
      .catch((err: unknown) => { if (alive) setError(err instanceof ApiError ? err.message : String(err)); });
    return () => { alive = false; };
  }, [load, nonce]);
  return { data, error, reload: () => setNonce((n) => n + 1) };
}

function OverviewSection() {
  const { data, error, reload } = useAdmin(useCallback(() => adminApi.lifeOverview(), []));
  if (error) return <AdminState kind="error" message={error} onRetry={reload} />;
  if (!data) return <AdminState kind="loading" />;
  return (
    <div className="life-overview" data-testid="life-overview">
      <div className="overview-card">
        <h3>她现在的状态</h3>
        <dl>
          <dt>在干嘛</dt><dd>{data.snapshot.activity}（{data.snapshot.kind}，心情 {data.snapshot.mood}）</dd>
          <dt>在哪里</dt><dd>{data.location ? `${data.location.name}（${data.location.kind}）` : '（未启用地点模型）'}</dd>
          <dt>天气</dt><dd>{data.weather ? `当前：${data.weather}` : '（未启用或未知）'}</dd>
          <dt>今日主题</dt><dd>{data.snapshot.theme ?? '—'}</dd>
          <dt>身体状态</dt><dd>{data.snapshot.vitals?.join('，') || '（未启用 Life V2）'}</dd>
          <dt>当前计划</dt><dd>{data.activePlan ? `${data.activePlan.title}（${data.activePlan.status}）` : '无'}</dd>
          <dt>进行中 Thread</dt><dd>{data.openThreads.length ? data.openThreads.map((t) => `${t.title} ${t.progress}%`).join('；') : '无'}</dd>
        </dl>
        <button type="button" onClick={reload}>刷新</button>
      </div>
      <div className="overview-card">
        <h3>最近事件</h3>
        <ul>
          {data.recentEvents.slice(0, 6).map((e) => (
            <li key={e.id}><span className="event-type">{e.eventType}</span> {e.description}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const VITAL_FIELDS: Array<{ key: keyof AdminLifeVitals; label: string }> = [
  { key: 'energy', label: '精力' },
  { key: 'hunger', label: '饥饿' },
  { key: 'stress', label: '压力' },
  { key: 'social_need', label: '社交需求' },
  { key: 'loneliness', label: '孤独' },
  { key: 'curiosity', label: '好奇' },
  { key: 'comfort', label: '舒适' },
  { key: 'focus', label: '专注' }
];

function VitalsSection() {
  const { data, error, reload } = useAdmin(useCallback(() => adminApi.lifeVitals(), []));
  const [, setNotice] = useAutoNotice();
  if (error) return <AdminState kind="error" message={error} onRetry={reload} />;
  if (!data?.vitals) return <AdminState kind="empty" message="（Life V2 未启用，暂无 vitals）" />;
  const adjust = async (field: string, delta: number) => {
    try {
      await adminApi.adjustVitals(field, delta);
      setNotice('已调整（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };
  const reset = async () => {
    try {
      await adminApi.resetVitals();
      setNotice('已重置（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };
  return (
    <div className="vitals-grid">
      {VITAL_FIELDS.map((f) => (
        <div className="vital-card" key={f.key}>
          <span className="vital-label">{f.label}</span>
          <strong>{Math.round(data.vitals![f.key])}</strong>
          <div className="vital-actions">
            <button type="button" onClick={() => void adjust(f.key, -5)}>−5</button>
            <button type="button" onClick={() => void adjust(f.key, 5)}>+5</button>
          </div>
        </div>
      ))}
      <div className="vital-card">
        <span className="vital-label">睡眠债</span>
        <strong>{data.vitals.sleep_debt}h</strong>
      </div>
      <div className="vitals-footer">
        <button type="button" onClick={() => void reset()}>重置为默认值</button>
      </div>
    </div>
  );
}

const PLAN_ACTIONS: Array<{ status: string; label: string }> = [
  { status: 'active', label: '激活' },
  { status: 'paused', label: '暂停' },
  { status: 'cancelled', label: '取消' },
  { status: 'skipped', label: '跳过' }
];

function PlansSection() {
  const { data, error, reload } = useAdmin(useCallback(() => adminApi.lifePlans(), []));
  const [, setNotice] = useAutoNotice();
  if (error) return <AdminState kind="error" message={error} onRetry={reload} />;
  if (!data) return <AdminState kind="loading" />;
  const update = async (id: string, patch: Parameters<typeof adminApi.updatePlan>[1]) => {
    try {
      await adminApi.updatePlan(id, patch);
      setNotice('计划已更新（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };
  return (
    <DataList<AdminLifePlan>
      testId="life-plan-list"
      rows={data.plans}
      rowKey={(plan) => plan.id}
      columns={[
        { key: 'title', label: '标题', render: (plan) => plan.title },
        { key: 'kind', label: '类型', mobileCollapsed: true, render: (plan) => plan.kind },
        { key: 'source', label: '来源', mobileCollapsed: true, render: (plan) => plan.source },
        { key: 'status', label: '状态', render: (plan) => plan.status },
        { key: 'time', label: '时间', mobileCollapsed: true, render: (plan) => plan.planned_start ? new Date(plan.planned_start).toLocaleString() : '—' }
      ]}
      expandable
      actions={(plan) => plan.status !== 'completed'
        ? PLAN_ACTIONS.map((a) => (
          <button key={a.status} type="button" onClick={() => void update(plan.id, { status: a.status })}>{a.label}</button>
        ))
        : <span className="muted">历史不可篡改</span>}
    />
  );
}

function ThreadsSection() {
  const { data, error, reload } = useAdmin(useCallback(() => adminApi.lifeThreads(), []));
  const [, setNotice] = useAutoNotice();
  if (error) return <AdminState kind="error" message={error} onRetry={reload} />;
  if (!data) return <AdminState kind="loading" />;
  const update = async (id: string, status: string) => {
    try {
      await adminApi.updateThread(id, status);
      setNotice('Thread 已更新（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };
  return (
    <DataList<AdminLifeThread>
      testId="life-thread-list"
      rows={data.threads}
      rowKey={(t) => t.id}
      columns={[
        { key: 'title', label: '标题', render: (t) => t.title },
        { key: 'category', label: '分类', mobileCollapsed: true, render: (t) => t.category },
        { key: 'progress', label: '进度', render: (t) => `${Math.round(t.progress * 100)}%` },
        { key: 'status', label: '状态', render: (t) => t.status }
      ]}
      expandable
      actions={(t) => (
        <>
          {t.status === 'open' && <button type="button" onClick={() => void update(t.id, 'paused')}>暂停</button>}
          {t.status !== 'resolved' && <button type="button" onClick={() => void update(t.id, 'resolved')}>完成</button>}
          {t.status !== 'abandoned' && <button type="button" onClick={() => void update(t.id, 'abandoned')}>归档</button>}
        </>
      )}
    />
  );
}

function EventsSection() {
  const { data, error, reload } = useAdmin(useCallback(() => adminApi.lifeEvents(100), []));
  if (error) return <AdminState kind="error" message={error} onRetry={reload} />;
  if (!data) return <AdminState kind="loading" />;
  if (data.events.length === 0) return <AdminState kind="empty" message="暂无生活事件" />;
  return (
    <ul className="event-list">
      {data.events.map((e) => (
        <li key={e.id}>
          <span className="event-type">{e.eventType}</span>
          <span>{e.description}</span>
          <span className="muted">{new Date(e.happenedAt).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

const LOCATION_KINDS = ['home', 'neighborhood', 'cafe', 'restaurant', 'store', 'park', 'library', 'mall', 'transit', 'work', 'study', 'venue', 'outdoor', 'other'];

function LocationsSection() {
  const { data, error, reload } = useAdmin(useCallback(() => adminApi.lifeLocations(), []));
  const [, setNotice] = useAutoNotice();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('cafe');
  const [pendingDelete, setPendingDelete] = useState<AdminLifeLocation | null>(null);
  const [pendingOverride, setPendingOverride] = useState<AdminLifeLocation | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <AdminState kind="error" message={error} onRetry={reload} />;
  if (!data) return <AdminState kind="loading" />;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await adminApi.createLocation({ name, kind });
      setName('');
      setNotice('地点已创建（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };

  const remove = async (location: AdminLifeLocation) => {
    setBusy(true);
    try {
      await adminApi.deleteLocation(location.id);
      setNotice('地点已停用（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
    finally { setBusy(false); setPendingDelete(null); }
  };

  const override = async (location: AdminLifeLocation) => {
    setBusy(true);
    try {
      await adminApi.overrideLocation(location.id, 'admin override');
      setNotice('已覆盖为当前地点（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
    finally { setBusy(false); setPendingOverride(null); }
  };

  return (
    <div>
<form className="admin-form" onSubmit={(e) => void create(e)} aria-label="新建地点">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新地点名称" required aria-label="新地点名称" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="地点类型">
          {LOCATION_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <button type="submit">创建</button>
      </form>
      {data.locations.length === 0
        ? <AdminState kind="empty" message="暂无地点" />
        : (
          <DataList<AdminLifeLocation>
            testId="life-location-list"
            rows={data.locations}
            rowKey={(l) => l.id}
            columns={[
              { key: 'name', label: '名称', render: (l) => l.name },
              { key: 'kind', label: '类型', render: (l) => l.kind },
              { key: 'tags', label: '标签', mobileCollapsed: true, render: (l) => l.tags.join('、') || '—' },
              { key: 'weight', label: '权重', mobileCollapsed: true, render: (l) => l.visitWeight }
            ]}
            expandable
            actions={(l) => (
              <>
                <button type="button" onClick={() => setPendingOverride(l)}>设为当前</button>
                <span className="danger-sep" aria-hidden="true" />
                <button type="button" className="admin-danger" onClick={() => setPendingDelete(l)}>停用</button>
              </>
            )}
          />
        )}
      <ConfirmDialog
        open={pendingOverride !== null}
        title="设为当前地点"
        message={`把当前地点覆盖为「${pendingOverride?.name ?? ''}」？这会立即改变她的世界上下文（写入审计）。`}
        confirmLabel="覆盖"
        busy={busy}
        onConfirm={() => { if (pendingOverride) void override(pendingOverride); }}
        onClose={() => { if (!busy) setPendingOverride(null); }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="停用地点"
        message={`停用「${pendingDelete?.name ?? ''}」后，她将不再访问这个地点。可以之后重新创建，但历史引用不会改写。`}
        confirmLabel="停用"
        busy={busy}
        onConfirm={() => { if (pendingDelete) void remove(pendingDelete); }}
        onClose={() => { if (!busy) setPendingDelete(null); }}
      />
    </div>
  );
}

function ProactiveSection() {
  const { data, error, reload } = useAdmin(useCallback(() => adminApi.proactiveAttempts(), []));
  if (error) return <AdminState kind="error" message={error} onRetry={reload} />;
  if (!data) return <AdminState kind="loading" />;
  if (data.attempts.length === 0) return <AdminState kind="empty" message="暂无主动开口记录" />;
  return (
    <DataList<AdminProactiveAttempt>
      testId="life-proactive-list"
      rows={data.attempts}
      rowKey={(a) => a.id}
      expandable
      columns={[
        { key: 'candidate', label: '候选', render: (a) => a.candidateId ?? '—' },
        { key: 'status', label: '状态', render: (a) => a.status },
        { key: 'reason', label: '原因', mobileCollapsed: true, render: (a) => a.blockedReason ?? '—' },
        { key: 'mode', label: '模式', mobileCollapsed: true, render: (a) => a.requestedMode ?? '—' },
        { key: 'message', label: '消息', mobileCollapsed: true, render: (a) => a.messageId ?? '—' },
        { key: 'time', label: '时间', render: (a) => new Date(a.createdAt).toLocaleString() }
      ]}
    />
  );
}

/* ---- Weather / Cities / Travel (frozen contract §2) ---- */

const CONDITION_LABELS: Record<string, string> = {
  clear: '晴', partly_cloudy: '多云间晴', cloudy: '多云', rain: '雨', drizzle: '毛毛雨',
  snow: '雪', storm: '雷暴', fog: '雾', haze: '霾', extreme_heat: '酷热', extreme_cold: '严寒', unknown: '未知'
};

const TRAVEL_MODE_LABELS: Record<string, string> = { walk: '步行', bike: '骑行', transit: '公共交通', car: '汽车', unknown: '未知' };

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).format(d);
}

function formatCacheAge(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  return `${(seconds / 3600).toFixed(1)} 小时前`;
}

/** Temperature bar: % of the list's range, container-driven, never fixed px. */
function temperatureWidth(temp: number | undefined, min: number, max: number): string {
  if (temp === undefined) return '0%';
  const span = Math.max(1, max - min);
  return `${Math.max(0, Math.min(100, ((temp - min) / span) * 100))}%`;
}

function ForecastList({ periods, testId }: { periods: WeatherForecastPeriod[]; testId: string }) {
  if (periods.length === 0) return <p className="muted">暂无预报</p>;
  const temps = periods.map((p) => p.temperatureC).filter((t): t is number => t !== undefined);
  const min = temps.length ? Math.min(...temps) : 0;
  const max = temps.length ? Math.max(...temps) : 1;
  return (
    <div className="forecast-list" data-testid={testId}>
      {periods.map((p) => (
        <div className="forecast-row" key={p.at}>
          <span className="forecast-time">{formatClock(p.at)}</span>
          <span className="forecast-track" aria-hidden="true">
            <i style={{ width: temperatureWidth(p.temperatureC, min, max) }} />
          </span>
          <span className="forecast-temp">{p.temperatureC !== undefined ? `${Math.round(p.temperatureC)}°` : '—'}</span>
          <span className="forecast-condition">{CONDITION_LABELS[p.condition] ?? p.condition}</span>
        </div>
      ))}
    </div>
  );
}

function WeatherSection() {
  const { data: citiesData, error: citiesError, reload: reloadCities } = useAdmin(useCallback(() => adminApi.lifeCities(), []));
  const { data: travelData, error: travelError, reload: reloadTravel } = useAdmin(useCallback(() => adminApi.lifeTravel(), []));
  const { data: weatherData, error: weatherError, reload: reloadWeather } = useAdmin(useCallback(() => adminApi.weatherStatus(), []));
  const { data: forecastData, error: forecastError, reload: reloadForecast } = useAdmin(useCallback(() => adminApi.weatherForecast(), []));
  const [, setNotice] = useAutoNotice();
  const [newCity, setNewCity] = useState({ name: '', region: '', country: '', timeZone: 'Asia/Shanghai' });
  const [refreshing, setRefreshing] = useState(false);

  const status = weatherData;
  const forecast = status?.forecast ?? forecastData?.forecast ?? null;
  const daylight = status?.daylight ?? null;
  const travel: TravelState | null = travelData?.travel ?? null;
  const cities = citiesData?.cities ?? null;

  const createCity = async (event: FormEvent) => {
    event.preventDefault();
    if (!newCity.name.trim() || !newCity.timeZone.trim()) {
      setNotice('城市名称与时区必填');
      return;
    }
    try {
      await adminApi.createCity({ name: newCity.name.trim(), region: newCity.region.trim() || undefined, country: newCity.country.trim() || undefined, timeZone: newCity.timeZone.trim() });
      setNewCity({ name: '', region: '', country: '', timeZone: 'Asia/Shanghai' });
      setNotice('城市已创建（写入审计）');
      reloadCities();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };

  const setActiveCity = async (city: LifeCity) => {
    try {
      await adminApi.updateCity(city.id, { active: true });
      setNotice(`活动城市已切换为 ${city.name}`);
      reloadCities();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };

  const forceRefresh = async () => {
    setRefreshing(true);
    try {
      await adminApi.weatherRefresh();
      setNotice('天气已强制刷新');
      reloadWeather();
      reloadForecast();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
    finally { setRefreshing(false); }
  };

  const weatherKind = weatherError
    ? adminStateFromError(weatherError)
    : status && status.enabled === false
      ? { kind: 'flag-disabled' as const, message: 'WEATHER_ENABLED 未开启，天气状态不可用。' }
      : null;

  return (
    <div className="weather-grid" data-testid="weather-section">
      <section className="weather-card" aria-labelledby="weather-cities-title">
        <h3 id="weather-cities-title">城市</h3>
        <form className="admin-form" onSubmit={(e) => void createCity(e)} aria-label="新建城市">
          <input value={newCity.name} onChange={(e) => setNewCity((c) => ({ ...c, name: e.target.value }))} placeholder="城市名（如 上海）" required aria-label="城市名" />
          <input value={newCity.region} onChange={(e) => setNewCity((c) => ({ ...c, region: e.target.value }))} placeholder="地区（可选）" aria-label="地区" />
          <input value={newCity.country} onChange={(e) => setNewCity((c) => ({ ...c, country: e.target.value }))} placeholder="国家（可选）" aria-label="国家" />
          <input value={newCity.timeZone} onChange={(e) => setNewCity((c) => ({ ...c, timeZone: e.target.value }))} placeholder="时区（IANA）" required aria-label="时区" />
          <button type="submit">新建</button>
        </form>
        {citiesError && <AdminState kind="error" message={citiesError} onRetry={reloadCities} />}
        {!citiesError && cities === null && <AdminState kind="loading" />}
        {!citiesError && cities !== null && cities.length === 0 && <AdminState kind="empty" message="还没有城市。创建一个后她会以该城市作为生活上下文。" />}
        {!citiesError && cities !== null && cities.length > 0 && (
          <DataList<LifeCity>
            testId="life-city-list"
            rows={cities}
            rowKey={(c) => c.id}
            columns={[
              { key: 'name', label: '名称', render: (c) => c.name },
              { key: 'region', label: '地区', mobileCollapsed: true, render: (c) => c.region ?? '—' },
              { key: 'tz', label: '时区', render: (c) => c.timeZone },
              { key: 'active', label: '状态', render: (c) => c.active ? '活动' : '—' }
            ]}
            expandable
            actions={(c) => !c.active
              ? <button type="button" onClick={() => void setActiveCity(c)}>设为当前</button>
              : <span className="muted">当前</span>}
          />
        )}
      </section>

      <section className="weather-card" aria-labelledby="weather-travel-title">
        <h3 id="weather-travel-title">行程</h3>
        {travelError && <AdminState kind="error" message={travelError} onRetry={reloadTravel} />}
        {!travelError && travelData === null && <AdminState kind="loading" />}
        {!travelError && travelData !== null && !travel && <AdminState kind="empty" message="当前没有行程。" />}
        {!travelError && travel && (
          <dl className="weather-kv">
            <dt>从</dt><dd>{travel.fromLocationId}</dd>
            <dt>到</dt><dd>{travel.toLocationId}</dd>
            <dt>方式</dt><dd>{TRAVEL_MODE_LABELS[travel.mode] ?? travel.mode}</dd>
            <dt>出发</dt><dd>{new Date(travel.startedAt).toLocaleString()}</dd>
            <dt>预计到达</dt><dd>{new Date(travel.expectedArriveAt).toLocaleString()}</dd>
          </dl>
        )}
      </section>

      <section className="weather-card weather-card-wide" aria-labelledby="weather-status-title">
        <h3 id="weather-status-title">天气状态</h3>
        {weatherError && <AdminState kind={weatherKind!.kind} message={weatherError} onRetry={reloadWeather} />}
        {!weatherError && weatherKind && <AdminState kind={weatherKind.kind} message={weatherKind.message} />}
        {!weatherError && !weatherKind && status === null && <AdminState kind="loading" />}
        {!weatherError && !weatherKind && status && (
          <>
            <dl className="weather-kv">
              <dt>Provider</dt>
              <dd>
                {status.provider.name ?? '—'}
                {status.provider.configured ? '' : '（未配置）'}
                {status.provider.active ? ' · 活跃' : ' · 备用'}
              </dd>
              <dt>当前天气</dt>
              <dd>
                {status.lastSnapshot
                  ? `${CONDITION_LABELS[status.lastSnapshot.condition] ?? status.lastSnapshot.condition}${status.lastSnapshot.temperatureC !== undefined ? ` ${Math.round(status.lastSnapshot.temperatureC)}°C` : ''}${status.lastSnapshot.stale ? '（stale）' : ''}`
                  : '—'}
              </dd>
              <dt>观测时间</dt>
              <dd>{status.lastSnapshot ? new Date(status.lastSnapshot.observedAt).toLocaleString() : '—'}</dd>
              <dt>缓存年龄</dt>
              <dd>{formatCacheAge(status.cacheAgeSec)}</dd>
              <dt>回退链路</dt>
              <dd>{status.fallback === null ? '—' : status.fallback === 'primary' ? 'primary（正常）' : `fallback → ${status.fallback}`}</dd>
              <dt>日出 / 日落</dt>
              <dd>
                {daylight
                  ? `${formatClock(daylight.sunrise)} / ${formatClock(daylight.sunset)}${daylight.isDaylight ? ' · 白天' : ' · 夜间'}`
                  : '—'}
              </dd>
            </dl>
            <div className="weather-actions">
              <button type="button" className="admin-button" onClick={() => void forceRefresh()} disabled={refreshing || !status.provider.configured}>
                {refreshing ? '刷新中…' : '强制刷新'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="weather-card weather-card-wide" aria-labelledby="weather-forecast-title">
        <h3 id="weather-forecast-title">预报</h3>
        {forecastError && <AdminState kind="error" message={forecastError} onRetry={reloadForecast} />}
        {!forecastError && weatherError === null && !weatherData && !forecastData && <AdminState kind="loading" />}
        {!forecastError && forecast === null && !weatherError && !(weatherData === null && forecastData === null) && <AdminState kind="empty" message="暂无预报数据（未启用或尚未生成）" />}
        {!forecastError && forecast && (
          <>
            {forecast.severe && <AdminState kind="error" message="检测到恶劣天气（storm / heavy_rain / extreme_heat / extreme_cold / snow / strong_wind）。" />}
            <div className="forecast-columns">
              <div>
                <h4>未来 12 小时</h4>
                <ForecastList periods={forecast.next12h} testId="forecast-12h" />
              </div>
              <div>
                <h4>未来 3 天</h4>
                <ForecastList periods={forecast.next3d} testId="forecast-3d" />
              </div>
            </div>
            <p className="muted">预报 provider：{forecast.provider} · 生成于 {new Date(forecast.generatedAt).toLocaleString()}</p>
          </>
        )}
      </section>
    </div>
  );
}

export type { WeatherStatus, WeatherCondition };
