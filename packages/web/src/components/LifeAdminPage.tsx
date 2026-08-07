import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../lib/api.js';
import { useAutoNotice } from '../lib/autoNotice.js';
import { AppLink } from './AppLink.js';
import {
  adminApi,
  type AdminLifeLocation,
  type AdminLifePlan,
  type AdminLifeThread,
  type AdminLifeVitals,
  type AdminProactiveAttempt
} from '../lib/admin.js';

type Section = 'overview' | 'vitals' | 'plans' | 'threads' | 'events' | 'locations' | 'proactive';

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'vitals', label: 'Vitals' },
  { key: 'plans', label: 'Plans' },
  { key: 'threads', label: 'Threads' },
  { key: 'events', label: 'Events' },
  { key: 'locations', label: 'Locations' },
  { key: 'proactive', label: 'Proactive' }
];

/**
 * Life Admin console (next phase P1): a complete management surface for the
 * life system. Admin mutations go through the audited API; the admin cannot
 * bypass the ReplyCoordinator or rewrite completed history.
 */
export default function LifeAdminPage() {
  const [section, setSection] = useState<Section>('overview');
  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-row">
          <h1>Life 管理中心</h1>
          <AppLink className="admin-back" href="/admin/features" aria-label="返回功能中心">‹ 返回</AppLink>
        </div>
        <nav className="admin-tabs" aria-label="Life 管理分区">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={section === s.key ? 'admin-tab active' : 'admin-tab'}
              onClick={() => setSection(s.key)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </header>
      {section === 'overview' && <OverviewSection />}
      {section === 'vitals' && <VitalsSection />}
      {section === 'plans' && <PlansSection />}
      {section === 'threads' && <ThreadsSection />}
      {section === 'events' && <EventsSection />}
      {section === 'locations' && <LocationsSection />}
      {section === 'proactive' && <ProactiveSection />}
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
  if (error) return <p className="admin-error">{error}</p>;
  if (!data) return <p>加载中…</p>;
  return (
    <div className="life-overview">
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
  if (error) return <p className="admin-error">{error}</p>;
  if (!data?.vitals) return <p>（Life V2 未启用，暂无 vitals）</p>;
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
  if (error) return <p className="admin-error">{error}</p>;
  if (!data) return <p>加载中…</p>;
  const update = async (id: string, patch: Parameters<typeof adminApi.updatePlan>[1]) => {
    try {
      await adminApi.updatePlan(id, patch);
      setNotice('计划已更新（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };
  return (
    <table className="admin-table">
      <thead><tr><th>标题</th><th>类型</th><th>来源</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
      <tbody>
        {data.plans.map((plan: AdminLifePlan) => (
          <tr key={plan.id}>
            <td>{plan.title}</td>
            <td>{plan.kind}</td>
            <td>{plan.source}</td>
            <td>{plan.status}</td>
            <td>{plan.planned_start ? new Date(plan.planned_start).toLocaleString() : '—'}</td>
            <td>
              {plan.status !== 'completed' && PLAN_ACTIONS.map((a) => (
                <button key={a.status} type="button" onClick={() => void update(plan.id, { status: a.status })}>{a.label}</button>
              ))}
              {plan.status === 'completed' && <span className="muted">历史不可篡改</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ThreadsSection() {
  const { data, error, reload } = useAdmin(useCallback(() => adminApi.lifeThreads(), []));
  const [, setNotice] = useAutoNotice();
  if (error) return <p className="admin-error">{error}</p>;
  if (!data) return <p>加载中…</p>;
  const update = async (id: string, status: string) => {
    try {
      await adminApi.updateThread(id, status);
      setNotice('Thread 已更新（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };
  return (
    <table className="admin-table">
      <thead><tr><th>标题</th><th>分类</th><th>进度</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>
        {data.threads.map((t: AdminLifeThread) => (
          <tr key={t.id}>
            <td>{t.title}</td>
            <td>{t.category}</td>
            <td>{Math.round(t.progress * 100)}%</td>
            <td>{t.status}</td>
            <td>
              {t.status === 'open' && <button type="button" onClick={() => void update(t.id, 'paused')}>暂停</button>}
              {t.status !== 'resolved' && <button type="button" onClick={() => void update(t.id, 'resolved')}>完成</button>}
              {t.status !== 'abandoned' && <button type="button" onClick={() => void update(t.id, 'abandoned')}>归档</button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EventsSection() {
  const { data, error } = useAdmin(useCallback(() => adminApi.lifeEvents(100), []));
  if (error) return <p className="admin-error">{error}</p>;
  if (!data) return <p>加载中…</p>;
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

function LocationsSection() {
  const { data, error, reload } = useAdmin(useCallback(() => adminApi.lifeLocations(), []));
  const [, setNotice] = useAutoNotice();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('cafe');
  if (error) return <p className="admin-error">{error}</p>;
  if (!data) return <p>加载中…</p>;
  const create = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await adminApi.createLocation({ name, kind });
      setName('');
      setNotice('地点已创建（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };
  const remove = async (id: string) => {
    try {
      await adminApi.deleteLocation(id);
      setNotice('地点已停用（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };
  const override = async (id: string) => {
    try {
      await adminApi.overrideLocation(id, 'admin override');
      setNotice('已覆盖为当前地点（写入审计）');
      reload();
    } catch (err) { setNotice(err instanceof ApiError ? err.message : String(err)); }
  };
  return (
    <div>
      <form className="admin-form" onSubmit={(e) => void create(e)}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="新地点名称" required />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {['home', 'neighborhood', 'cafe', 'restaurant', 'store', 'park', 'library', 'mall', 'transit', 'work', 'study', 'venue', 'outdoor', 'other'].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <button type="submit">创建</button>
      </form>
      <table className="admin-table">
        <thead><tr><th>名称</th><th>类型</th><th>标签</th><th>权重</th><th>操作</th></tr></thead>
        <tbody>
          {data.locations.map((l: AdminLifeLocation) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td>{l.kind}</td>
              <td>{l.tags.join('、')}</td>
              <td>{l.visitWeight}</td>
              <td>
                <button type="button" onClick={() => void override(l.id)}>设为当前</button>
                <button type="button" onClick={() => void remove(l.id)}>停用</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProactiveSection() {
  const { data, error } = useAdmin(useCallback(() => adminApi.proactiveAttempts(), []));
  if (error) return <p className="admin-error">{error}</p>;
  if (!data) return <p>加载中…</p>;
  return (
    <table className="admin-table">
      <thead><tr><th>候选</th><th>状态</th><th>原因</th><th>模式</th><th>消息</th><th>时间</th></tr></thead>
      <tbody>
        {data.attempts.map((a: AdminProactiveAttempt) => (
          <tr key={a.id}>
            <td>{a.candidateId ?? '—'}</td>
            <td>{a.status}</td>
            <td>{a.blockedReason ?? '—'}</td>
            <td>{a.requestedMode ?? '—'}</td>
            <td>{a.messageId ?? '—'}</td>
            <td>{new Date(a.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
