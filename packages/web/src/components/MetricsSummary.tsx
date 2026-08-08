import { useEffect, useMemo, useState } from 'react';
import { adminApi, getAdminToken, type MetricAggregate, type MetricsDistribution } from '../lib/admin.js';
import { AdminState } from './admin/AdminState.js';

/**
 * MetricsSummary — 基础运行监控，嵌入 Admin「概览」。
 * 只展示运行指标（success/failure/latency、count/mean/p50/p95），
 * 不做独立分析平台（release comparison / export 已移除）。
 */
const CATEGORY_LABELS: Record<string, string> = {
  reply: '回复',
  voice: '语音',
  life: '生活',
  proactive: '主动消息',
  world: '世界'
};

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

export function MetricsSummary() {
  const [aggregates, setAggregates] = useState<MetricAggregate[] | null>(null);
  const [distributions, setDistributions] = useState<MetricsDistribution[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!getAdminToken()) { setError('缺少管理令牌'); return; }
    setError(null);
    setAggregates(null);
    setDistributions(null);
    void adminApi.metrics(7).then((body) => { if (alive) setAggregates(body.aggregates); }).catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    void adminApi.metricsDistributions(7).then((body) => { if (alive) setDistributions(body.distributions); }).catch(() => undefined);
    return () => { alive = false; };
  }, [nonce]);

  const categories = useMemo(() => [...new Set((aggregates ?? []).map((a) => a.category))], [aggregates]);

  if (error) return <AdminState kind="error" message={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!aggregates) return <AdminState kind="loading" />;
  if (aggregates.length === 0 && !distributions?.length) {
    return <AdminState kind="empty" message="暂无指标数据 — 开启 METRICS_DASHBOARD_ENABLED 后开始记录" />;
  }

  return (
    <section className="metrics-summary" data-testid="metrics-summary" aria-labelledby="metrics-summary-title">
      <h3 id="metrics-summary-title">运行指标（近 7 天）</h3>
      {categories.length === 0 && <p className="muted">暂无聚合指标。</p>}
      {categories.map((category) => (
        <div className="metrics-summary-category" key={category}>
          <strong>{CATEGORY_LABELS[category] ?? category}</strong>
          <div className="metrics-summary-rows">
            {aggregates!.filter((a) => a.category === category).map((a) => (
              <span key={a.metric} className="metrics-summary-row" title={`${a.count} 次 · 均值 ${formatNumber(a.avg)}`}>
                <span className="muted">{a.metric}</span>
                <span>{formatNumber(a.sum)}<small className="muted">×{a.count}</small></span>
              </span>
            ))}
          </div>
        </div>
      ))}
      {distributions && distributions.length > 0 && (
        <div className="metrics-summary-category">
          <strong>分布（p50 / p95）</strong>
          <div className="metrics-summary-rows">
            {distributions.slice(0, 8).map((d) => (
              <span key={`${d.category}-${d.metric}`} className="metrics-summary-row" title={`min ${formatNumber(d.min)} · max ${formatNumber(d.max)}`}>
                <span className="muted">{CATEGORY_LABELS[d.category] ?? d.category} / {d.metric}</span>
                <span>p50 {formatNumber(d.p50)} · p95 {formatNumber(d.p95)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
