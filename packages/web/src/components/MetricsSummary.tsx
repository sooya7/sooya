import { useEffect, useMemo, useState } from 'react';
import { adminApi, getAdminToken, type MetricAggregate } from '../lib/admin.js';
import { AdminState } from './admin/AdminState.js';

/**
 * MetricsSummary — 嵌入 Admin「概览」的近 7 天体验摘要。
 * 服务端记录的是英文指标键（reply.latency_ms 等）；这里不做监控面板，
 * 只把它们折算成几个用户能直接感受到的数字：回复快不快、稳不稳、
 * 语音靠不靠谱、她主动说了多少话。
 */

function sumOf(aggregates: MetricAggregate[], category: string, metric: string): number {
  const row = aggregates.find((a) => a.category === category && a.metric === metric);
  return row ? row.sum : 0;
}

function avgOf(aggregates: MetricAggregate[], category: string, metric: string): number | null {
  const row = aggregates.find((a) => a.category === category && a.metric === metric);
  return row && row.count > 0 ? row.avg : null;
}

function formatSeconds(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? '1 秒内' : `${(ms / 1000).toFixed(1)} 秒`;
}

function formatRate(good: number, total: number): string {
  if (total <= 0) return '—';
  return `${Math.round((good / total) * 100)}%`;
}

export function MetricsSummary() {
  const [aggregates, setAggregates] = useState<MetricAggregate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!getAdminToken()) { setError('缺少管理令牌'); return; }
    setError(null);
    setAggregates(null);
    void adminApi.metrics(7).then((body) => { if (alive) setAggregates(body.aggregates); }).catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [nonce]);

  const tiles = useMemo(() => {
    if (!aggregates) return [];
    const replyStart = sumOf(aggregates, 'reply', 'start');
    const replySuccess = sumOf(aggregates, 'reply', 'success');
    const firstVisible = avgOf(aggregates, 'reply', 'first_visible_ms');
    const ttsSuccess = sumOf(aggregates, 'voice', 'tts_success');
    const ttsFailure = sumOf(aggregates, 'voice', 'tts_failure');
    const proactive = sumOf(aggregates, 'proactive', 'sent');
    return [
      { label: '开始回话', value: formatSeconds(firstVisible), detail: '从你发出到她开口的平均等待' },
      { label: '回复成功率', value: formatRate(replySuccess, replyStart), detail: replyStart > 0 ? `共回复 ${replyStart.toLocaleString('en-US')} 次` : '还没有回复记录' },
      { label: '语音成功率', value: formatRate(ttsSuccess, ttsSuccess + ttsFailure), detail: ttsSuccess + ttsFailure > 0 ? `合成 ${(ttsSuccess + ttsFailure).toLocaleString('en-US')} 段语音` : '还没有语音记录' },
      { label: '主动找你', value: proactive > 0 ? `${proactive.toLocaleString('en-US')} 次` : '—', detail: '她主动发来的消息' }
    ];
  }, [aggregates]);

  if (error) return <AdminState kind="error" message={error} onRetry={() => setNonce((n) => n + 1)} />;
  if (!aggregates) return <AdminState kind="loading" />;
  if (aggregates.length === 0) {
    return <AdminState kind="empty" message="暂无体验数据 — 开启 METRICS_DASHBOARD_ENABLED 后开始记录" />;
  }

  return (
    <section className="metrics-summary" data-testid="metrics-summary" aria-labelledby="metrics-summary-title">
      <h3 id="metrics-summary-title">最近 7 天的体验</h3>
      <div className="admin-summary">
        {tiles.map((tile) => (
          <div className="admin-summary-tile" key={tile.label}>
            <span>{tile.label}</span>
            <strong>{tile.value}</strong>
            <small>{tile.detail}</small>
          </div>
        ))}
      </div>
    </section>
  );
}
