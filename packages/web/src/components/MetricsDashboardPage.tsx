import { useEffect, useState } from 'react';
import { getAdminToken } from '../lib/admin.js';
import { AppLink } from './AppLink.js';

export interface MetricAggregate { category: string; metric: string; sum: number; count: number; avg: number; }

const CATEGORY_LABELS: Record<string, string> = {
  reply: 'Reply',
  voice: 'Voice',
  life: 'Life',
  proactive: 'Proactive'
};

/**
 * Metrics dashboard (next phase P2): privacy-safe aggregates only — no
 * message text, transcripts or addresses are ever shown.
 */
export default function MetricsDashboardPage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<MetricAggregate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const token = getAdminToken();
    if (!token) { setError('缺少管理令牌'); return; }
    fetch(`/api/admin/metrics?days=${days}`, { headers: { 'x-admin-token': token } })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        const body = (await res.json()) as { aggregates: MetricAggregate[] };
        if (alive) setData(body.aggregates);
      })
      .catch((err: unknown) => { if (alive) setError(String(err)); });
    return () => { alive = false; };
  }, [days]);

  const categories = [...new Set((data ?? []).map((a) => a.category))];

  return (
    <div className="admin-page" data-testid="metrics-page">
      <header className="admin-header">
        <div className="admin-header-row">
          <h1>Metrics 仪表盘</h1>
          <AppLink className="admin-back" href="/admin/features" aria-label="返回功能中心">‹ 返回</AppLink>
        </div>
        <label className="metrics-range">
          范围：
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
            <option value={90}>90 天</option>
          </select>
        </label>
      </header>
      {error && <p className="admin-error">{error}</p>}
      {!data && !error && <p>加载中…</p>}
      {data && data.length === 0 && <p>（暂无指标数据 — 开启 METRICS_DASHBOARD_ENABLED 后开始记录）</p>}
      {categories.map((category) => (
        <section key={category} className="metrics-category">
          <h2>{CATEGORY_LABELS[category] ?? category}</h2>
          <table className="admin-table">
            <thead><tr><th>指标</th><th>次数</th><th>总和</th><th>均值</th></tr></thead>
            <tbody>
              {data!.filter((a) => a.category === category).map((a) => (
                <tr key={a.metric}>
                  <td>{a.metric}</td>
                  <td>{a.count}</td>
                  <td>{Math.round(a.sum * 100) / 100}</td>
                  <td>{a.count > 0 ? Math.round(a.avg * 100) / 100 : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
