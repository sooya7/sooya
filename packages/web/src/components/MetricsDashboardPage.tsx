import { useEffect, useMemo, useState } from 'react';
import { adminApi, adminFailureKind, getAdminToken, type MetricAggregate, type MetricsDistribution, type ReleaseMetricsComparison } from '../lib/admin.js';
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
 * wrap instead of stretching the layout. Includes release compare + CSV/JSON
 * export (frozen contract §2).
 */
export default function MetricsDashboardPage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<MetricAggregate[] | null>(null);
  const [distributions, setDistributions] = useState<MetricsDistribution[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'unauthorized' | 'flag-disabled' | 'provider-unconfigured' | 'error'>('error');
  const [nonce, setNonce] = useState(0);
  const [compare, setCompare] = useState<ReleaseMetricsComparison | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'json' | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [mobileSeries, setMobileSeries] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!getAdminToken()) { setError('缺少管理令牌'); return; }
    setError(null);
    setErrorKind('error');
    setData(null);
    setDistributions(null);
    setCompare(null);
    setCompareError(null);
    void adminApi.metrics(days).then((body) => { if (alive) setData(body.aggregates); }).catch((err: unknown) => {
      if (!alive) return;
      const state = adminStateFromError(err);
      setErrorKind(state.kind);
      setError(state.message);
    });
    void adminApi.metricsDistributions(days).then((body) => { if (alive) setDistributions(body.distributions); }).catch(() => undefined);
    void adminApi.metricsReleaseCompare(localDateKey(new Date(Date.now() - days * 86_400_000)), localDateKey(new Date())).then((body) => { if (alive) setCompare(body); }).catch((err: unknown) => { if (alive) setCompareError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [days, nonce]);

  const categories = useMemo(() => [...new Set((data ?? []).map((a) => a.category))], [data]);

  const exportMetrics = async (format: 'csv' | 'json') => {
    setExporting(format);
    setExportNotice(null);
    try {
      await adminApi.metricsExport(format);
      setExportNotice(`已导出 ${format.toUpperCase()}（只含指标，不含私人正文）`);
    } catch (err) {
      setExportNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  };

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
      {exportNotice && <div className="admin-notice" role="status" data-testid="metrics-export-notice">{exportNotice}</div>}
      {failure && <AdminState kind={failure.kind} message={error!} onRetry={() => setNonce((n) => n + 1)} />}
      {!error && !data && <AdminState kind="loading" />}
      {data && data.length === 0 && <AdminState kind="empty" message="暂无指标数据 — 开启 METRICS_DASHBOARD_ENABLED 后开始记录" />}
      {categories.map((category) => (
        <MetricsCategory key={category} category={category} rows={data!.filter((a) => a.category === category)} mobileSeries={mobileSeries} onToggleSeries={() => setMobileSeries((v) => !v)} />
      ))}

      <section className="metrics-category" aria-labelledby="metrics-compare-title">
        <h2 id="metrics-compare-title">Release 对比</h2>
        {compareError && <AdminState kind={adminFailureKind(compareError) === 'flag-disabled' ? 'flag-disabled' : 'error'} message={compareError} />}
        {!compareError && compare === null && <AdminState kind="loading" />}
        {compare && (
          <div className="compare-grid" data-testid="metrics-compare">
            <div className="compare-col">
              <h3>当前区间（{compare.current.from} → {compare.current.to}）</h3>
              <DataList<MetricAggregate>
                rows={compare.current.aggregates}
                rowKey={(a) => `${a.category}-${a.metric}`}
                columns={[
                  { key: 'metric', label: '指标', render: (a) => a.metric },
                  { key: 'count', label: '次数', render: (a) => a.count },
                  { key: 'sum', label: '总和', render: (a) => formatNumber(a.sum) }
                ]}
              />
            </div>
            <div className="compare-col">
              <h3>上一区间（{compare.previous.from} → {compare.previous.to}）</h3>
              <DataList<MetricAggregate>
                rows={compare.previous.aggregates}
                rowKey={(a) => `${a.category}-${a.metric}`}
                columns={[
                  { key: 'metric', label: '指标', render: (a) => a.metric },
                  { key: 'count', label: '次数', render: (a) => a.count },
                  { key: 'sum', label: '总和', render: (a) => formatNumber(a.sum) }
                ]}
              />
            </div>
            <div className="compare-col compare-col-wide">
              <h3>差异</h3>
              <DataList<{ metric: string; current: number; previous: number; delta: number }>
                rows={compare.current.aggregates.map((a) => {
                  const previous = compare.previous.aggregates.find((p) => p.category === a.category && p.metric === a.metric);
                  const prevCount = previous?.count ?? 0;
                  const delta = prevCount === 0 ? (a.count > 0 ? 1 : 0) : (a.count - prevCount) / prevCount;
                  return { metric: `${CATEGORY_LABELS[a.category] ?? a.category} / ${a.metric}`, current: a.count, previous: prevCount, delta };
                })}
                rowKey={(r) => r.metric}
                columns={[
                  { key: 'metric', label: '指标', render: (r) => r.metric },
                  { key: 'current', label: '当前', render: (r) => r.current },
                  { key: 'previous', label: '上一区间', render: (r) => r.previous },
                  {
                    key: 'delta',
                    label: '变化',
                    render: (r) => {
                      if (r.delta === 0) return <span>—</span>;
                      const up = r.delta > 0;
                      return <span className={up ? 'delta-up' : 'delta-down'}>{up ? '▲' : '▼'} {formatNumber(Math.abs(r.delta) * 100)}%</span>;
                    }
                  }
                ]}
              />
            </div>
          </div>
        )}
      </section>

      <section className="metrics-category" aria-labelledby="metrics-export-title">
        <h2 id="metrics-export-title">导出</h2>
        <div className="admin-actions">
          <button type="button" className="admin-button primary" disabled={exporting !== null} onClick={() => void exportMetrics('csv')}>
            {exporting === 'csv' ? '导出中…' : '导出 CSV'}
          </button>
          <button type="button" className="admin-button" disabled={exporting !== null} onClick={() => void exportMetrics('json')}>
            {exporting === 'json' ? '导出中…' : '导出 JSON'}
          </button>
          <span className="muted">只含指标，不含私人正文</span>
        </div>
      </section>

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
function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}
