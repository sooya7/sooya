import { useCallback, useEffect, useState } from 'react';
import { adminApi, type DecisionTrace } from '../lib/admin.js';
import { AppLink } from './AppLink.js';
import { AdminState, adminStateFromError } from './admin/AdminState.js';

const GUARD_LABELS: Record<string, string> = { pass: '通过', reject: '拒绝', fallback: '回退' };

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' }).format(d);
}

/**
 * Decision Trace (/admin/decision-trace, frozen contract §2). Admin-only
 * (X-Admin-Token via adminApi). Desktop: two columns (timeline | detail).
 * Mobile: single column; metadata is one card and long JSON sits in
 * collapsible, locally-scrolling code blocks.
 */
export default function DecisionTracePage() {
  const [traces, setTraces] = useState<DecisionTrace[] | null>(null);
  const [selected, setSelected] = useState<DecisionTrace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<'unauthorized' | 'flag-disabled' | 'provider-unconfigured' | 'error'>('error');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailErrorKind, setDetailErrorKind] = useState<'unauthorized' | 'flag-disabled' | 'provider-unconfigured' | 'error'>('error');
  const [nonce, setNonce] = useState(0);

  const load = useCallback(() => {
    setError(null);
    setErrorKind('error');
    adminApi.decisionTraces(50)
      .then((body) => {
        setTraces(body.traces);
        setSelected((previous) => previous ?? body.traces[0] ?? null);
      })
      .catch((err: unknown) => {
        const state = adminStateFromError(err);
        setErrorKind(state.kind);
        setError(state.message);
      });
  }, []);

  useEffect(() => { load(); }, [load, nonce]);

  const select = (trace: DecisionTrace) => {
    setSelected(trace);
    setDetailError(null);
    adminApi.decisionTrace(trace.batchId, trace.revision)
      .then((body) => setSelected(body.trace))
      .catch((err: unknown) => {
        const state = adminStateFromError(err);
        setDetailErrorKind(state.kind);
        setDetailError(state.message);
      });
  };

  return (
    <div className="admin-page" data-testid="decision-trace-page">
      <header className="admin-header">
        <div className="admin-header-row">
          <h1>Decision Trace</h1>
          <AppLink className="admin-back" href="/admin/features" aria-label="返回功能中心">‹ 返回</AppLink>
        </div>
        <p className="admin-eyebrow">仅管理员可见（X-Admin-Token）· 决策溯源，不含提示词与内部安全规则</p>
      </header>
      {error && <AdminState kind={errorKind} message={error} onRetry={() => setNonce((n) => n + 1)} />}
      {!error && !traces && <AdminState kind="loading" />}
      {!error && traces && traces.length === 0 && (
        <AdminState kind="empty" message="暂无决策记录。开启 ADMIN_DECISION_TRACE_ENABLED 后，每条回复会留下可追溯的决策摘要。" />
      )}
      {!error && traces && traces.length > 0 && (
        <div className="trace-layout">
          <section aria-labelledby="trace-list-title">
            <h2 id="trace-list-title" className="admin-eyebrow">时间线</h2>
            <div className="trace-list" role="list" aria-label="决策时间线">
              {traces.map((trace) => (
                <button
                  key={`${trace.batchId}-${trace.revision}`}
                  type="button"
                  className={`trace-item${selected?.batchId === trace.batchId && selected?.revision === trace.revision ? ' active' : ''}`}
                  aria-current={selected?.batchId === trace.batchId && selected?.revision === trace.revision ? 'true' : undefined}
                  onClick={() => select(trace)}
                >
                  <strong>{formatTime(trace.createdAt)}</strong>
                  <small>{trace.batchId} · r{trace.revision}{trace.replyIntent ? ` · ${trace.replyIntent}` : ''}{trace.semanticGuard ? ` · guard ${GUARD_LABELS[trace.semanticGuard] ?? trace.semanticGuard}` : ''}</small>
                </button>
              ))}
            </div>
          </section>
          <section aria-labelledby="trace-detail-title">
            <h2 id="trace-detail-title" className="admin-eyebrow">详情</h2>
            {!selected ? <AdminState kind="empty" message="选择一条记录查看详情" /> : (
              <div className="trace-meta-card" data-testid="trace-detail">
                {detailError && <AdminState kind={detailErrorKind} message={detailError} />}
                <dl className="trace-meta">
                  <dt>Batch</dt><dd>{selected.batchId}</dd>
                  <dt>Revision</dt><dd>{selected.revision}</dd>
                  <dt>时间</dt><dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                  <dt>回复意图</dt><dd>{selected.replyIntent ?? '—'}</dd>
                  <dt>生活上下文</dt><dd>{selected.lifeContext?.length ? selected.lifeContext.join('；') : '—'}</dd>
                  <dt>天气</dt><dd>{selected.weather ?? '—'}</dd>
                  <dt>记忆召回</dt><dd>{selected.memoryRecallCount !== null && selected.memoryRecallCount !== undefined ? `${selected.memoryRecallCount} 条` : '—'}</dd>
                  <dt>语音模式</dt><dd>{selected.voiceMode ?? '—'}</dd>
                  <dt>语义守卫</dt><dd>{selected.semanticGuard ? GUARD_LABELS[selected.semanticGuard] ?? selected.semanticGuard : '—'}</dd>
                  <dt>实验变体</dt><dd>{selected.experimentVariant ?? '—'}</dd>
                  <dt>主动消息</dt><dd>{selected.proactive ?? '—'}</dd>
                </dl>
                <details className="trace-section" data-testid="trace-json-section">
                  <summary>原始 JSON（默认折叠）</summary>
                  <pre className="shadow-code" tabIndex={0}>{JSON.stringify(selected, null, 2)}</pre>
                </details>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export type { DecisionTrace };
