import { useEffect, useMemo, useState } from 'react';
import { adminApi, getAdminToken, type MetricAggregate, type MetricsDistribution } from '../lib/admin.js';
import { AppLink } from './AppLink.js';
import { AdminState, adminStateFromError } from './admin/AdminState.js';
import { DataList } from './admin/DataList.js';

export type { MetricAggregate } from '../lib/admin.js';

const CATEGORY_LABELS: Record<string, string> = {
  reply: 'Reply',
  voice: 'Voice',
  life: 'Life',
  proactive: 'Proactive'
};

const RANGES = [7, 30, 90];

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

/**
 * Metrics dashboard (next phase P2): privacy-safe aggregates only — no
 * message text, transcripts or addresses are ever shown. Charts are
 * container-driven percentage bars (never fixed px), the range selector is a
 * touch-friendly segmented control, legends wrap, and big numbers/labels
 * wrap instead of stretching the layout. Distributions (p50/p95) included.
 */
export default function MetricsDashboardPage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<MetricAggregate[] | null>(null);
  const [distributions, setDistributions] = useState<MetricsDistribution[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'unauthorized' | 'flag-disabled' | 'provider-unconfigured' | 'error'>('error');
  const [nonce, setNonce] = useState(0);
  const [mobileSeries, setMobileSeries] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!getAdminToken()) { setError('缺少管理令牌'); return; }
    setError(null);
    setErrorKind('error');
    setData(null);
    setDistributions(null);
    void adminApi.metrics(days).then((body) => { if (alive) setData(body.aggregates); }).catch((err: unknown) => {
      if (!alive) return;
      const state = adminStateFromError(err);
      setErrorKind(state.kind);
      setError(state.message);
    });
    void adminApi.metricsDistributions(days).then((body) => { if (alive) setDistributions(body.distributions); }).catch(() => undefined);
    return () => { alive = false; };
  }, [days, nonce]);

  const categories = useMemo(() => [...new Set((data ?? []).map((a) => a.category))], [data]);

  const failure = error ? { kind: errorKind, message: error } : null;

  return (
    <div className="admin-page" data-testid="metrics-page">
      <header className="admin-header">
        <div className="admin-header-row">
          <h1>Metrics 仪表盘</h1>
          <AppLink className="admin-back" href="/admin/features" aria-label="返回功能中心">‹ 返回</AppLink>
        </div>
        <div className="metrics-range" role="group" aria-label="统计范围">
          <span className="muted">范围：</span>
          <div className="range-seg">
            {RANGES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={days === value}
                onClick={() => setDays(value)}
              >
                {value} 天
              </button>
            ))}
          </div>
        </div>
      </header>
      {failure && <AdminState kind={failure.kind} message={error!} onRetry={() => setNonce((n) => n + 1)} />}
      {!error && !data && <AdminState kind="loading" />}
      {data && data.length === 0 && <AdminState kind="empty" message="暂无指标数据 — 开启 METRICS_DASHBOARD_ENABLED 后开始记录" />}
      {categories.map((category) => (
        <MetricsCategory key={category} category={category} rows={data!.filter((a) => a.category === category)} mobileSeries={mobileSeries} onToggleSeries={() => setMobileSeries((v) => !v)} />
      ))}

      {distributions && distributions.length > 0 && (
        <section className="metrics-category" aria-labelledby="metrics-dist-title">
          <h2 id="metrics-dist-title">分布（p50 / p95）</h2>
          <DataList<MetricsDistribution>
            rows={distributions}
            rowKey={(d) => `${d.category}-${d.metric}`}
            expandable
            columns={[
              { key: 'metric', label: '指标', render: (d) => `${CATEGORY_LABELS[d.category] ?? d.category} / ${d.metric}` },
              { key: 'count', label: '样本', render: (d) => d.count },
              { key: 'p50', label: 'p50', render: (d) => formatNumber(d.p50) },
              { key: 'p95', label: 'p95', render: (d) => formatNumber(d.p95) },
              { key: 'minmax', label: 'min / max', mobileCollapsed: true, render: (d) => `${formatNumber(d.min)} / ${formatNumber(d.max)}` }
            ]}
          />
        </section>
      )}
    </div>
  );
}

function MetricsCategory({ category, rows, mobileSeries, onToggleSeries }: { category: string; rows: MetricAggregate[]; mobileSeries: boolean; onToggleSeries: () => void }) {
  const max = Math.max(1, ...rows.map((a) => a.sum));
  const visible = mobileSeries ? rows.slice(0, 3) : rows;
  const hidden = rows.length - visible.length;
  return (
    <section className="metrics-category" aria-labelledby={`metrics-cat-${category}`}>
      <h2 id={`metrics-cat-${category}`}>{CATEGORY_LABELS[category] ?? category}</h2>
      <div className="metrics-legend" aria-hidden="true">
        <span>■ 总和（相对当前分类最大值）</span>
      </div>
      <div className="metrics-bars" data-testid={`metrics-bars-${category}`}>
        {visible.map((a) => (
          <div className="metric-bar-row" key={a.metric}>
            <span>{a.metric}</span>
            <span className="metric-bar" aria-hidden="true"><i style={{ width: `${Math.max(1, (a.sum / max) * 100)}%` }} /></span>
            <span className="metric-bar-value" title={`${a.count} 次，均值 ${formatNumber(a.avg)}`}>
              {formatNumber(a.sum)} <span className="muted">×{a.count}</span>
            </span>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button type="button" className="metrics-more" onClick={onToggleSeries} aria-expanded={!mobileSeries}>
          {mobileSeries ? `展开其余 ${hidden} 项` : '收起'}
        </button>
      )}
      <DataList<MetricAggregate>
        rows={rows}
        rowKey={(a) => `${a.category}-${a.metric}`}
        columns={[
          { key: 'metric', label: '指标', render: (a) => a.metric },
          { key: 'count', label: '次数', render: (a) => a.count },
          { key: 'sum', label: '总和', render: (a) => formatNumber(a.sum) },
          { key: 'avg', label: '均值', render: (a) => a.count > 0 ? formatNumber(a.avg) : '—' }
        ]}
      />
    </section>
  );
}

/** LIFE_TIME_ZONE 本地日期（归档键）：客户端用浏览器本地日期近似。 */
