import { useEffect, useMemo, useState } from 'react';
import { shadowApi, type ShadowRun } from '../lib/shadowExperiments.js';
import { AdminNotice, AdminState } from './admin/AdminState.js';
import { DataList } from './admin/DataList.js';

const SUBSYSTEM_LABELS: Record<string, string> = {
  'life.activity_selector': '生活活动选择',
  'life.location_selector': '位置选择'
};

function diffLabel(run: ShadowRun): { equal: boolean; text: string } {
  try {
    const diff = JSON.parse(run.diff_json) as { equal?: boolean };
    return { equal: diff.equal !== false, text: diff.equal === false ? '有差异' : '一致' };
  } catch {
    return { equal: true, text: '—' };
  }
}

/** Pretty-printed JSON for reading; falls back to the raw text. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export default function ShadowRunsPage() {
  const [runs, setRuns] = useState<ShadowRun[] | null>(null);
  const [subsystem, setSubsystem] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error'>('ok');

  const load = () => {
    shadowApi.runs(subsystem || undefined)
      .then((result) => { setRuns(result.runs); setNotice(''); })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : '加载失败');
        setNoticeKind('error');
      });
  };
  useEffect(() => { load(); }, [subsystem]);

  const stats = useMemo(() => {
    if (!runs) return null;
    const total = runs.length;
    const equal = runs.filter((r) => diffLabel(r).equal).length;
    const bySubsystem = new Map<string, { total: number; diff: number }>();
    for (const run of runs) {
      const entry = bySubsystem.get(run.subsystem) ?? { total: 0, diff: 0 };
      entry.total += 1;
      if (!diffLabel(run).equal) entry.diff += 1;
      bySubsystem.set(run.subsystem, entry);
    }
    return { total, equal, diff: total - equal, bySubsystem };
  }, [runs]);

  return (
    <div className="admin-page" data-testid="shadow-runs-page">
      <div className="admin-panel-heading">
        <div>
          <h2>Shadow 对比</h2>
          <p>实验性候选与当前正式决策的只读对比。Shadow 永不写入状态，仅记录差异；关闭 SHADOW_MODE_ENABLED 后不再采样。</p>
        </div>
      </div>
      {notice && <AdminNotice kind={noticeKind}>{notice}</AdminNotice>}
      <section className="admin-form-card">
        <div className="admin-summary">
          <label className="admin-card">
            <strong>子系统</strong>
            <select value={subsystem} onChange={(event) => setSubsystem(event.target.value)}>
              <option value="">全部</option>
              {Object.entries(SUBSYSTEM_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="admin-card">
            <strong>统计</strong>
            <span data-testid="shadow-run-count">{stats ? `${stats.total} 次采样 · ${stats.diff} 次有差异` : '—'}</span>
          </label>
        </div>
        {stats && stats.total > 0 && (
          <DataList<{ subsystem: string; total: number; diff: number }>
            testId="shadow-run-stats"
            rows={[...stats.bySubsystem.entries()].map(([key, entry]) => ({ subsystem: key, total: entry.total, diff: entry.diff }))}
            rowKey={(entry) => entry.subsystem}
            columns={[
              { key: 'subsystem', label: '子系统', render: (entry) => SUBSYSTEM_LABELS[entry.subsystem] ?? entry.subsystem },
              { key: 'total', label: '采样', render: (entry) => entry.total },
              { key: 'diff', label: '有差异', render: (entry) => entry.diff }
            ]}
          />
        )}
      </section>
      <section className="admin-form-card">
        <h3>最近采样</h3>
        {!runs ? <AdminState kind="loading" /> : runs.length === 0 ? (
          <AdminState kind="empty" message="暂无采样。开启 SHADOW_MODE_ENABLED 后，生活活动与位置选择会在这里留下对比记录。" />
        ) : (
          <DataList<ShadowRun>
            testId="shadow-run-table"
            rows={runs.slice(0, 50)}
            rowKey={(run) => run.id}
            expandable
            columns={[
              { key: 'time', label: '时间', render: (run) => new Date(run.created_at).toLocaleString() },
              { key: 'subsystem', label: '子系统', render: (run) => SUBSYSTEM_LABELS[run.subsystem] ?? run.subsystem },
              { key: 'canonical', label: '正式版', mobileCollapsed: true, render: (run) => run.canonical_version },
              { key: 'shadow', label: '候选版', mobileCollapsed: true, render: (run) => run.shadow_version },
              { key: 'result', label: '结果', render: (run) => {
                const diff = diffLabel(run);
                return <span className={diff.equal ? '' : 'text-danger'}>{diff.text}</span>;
              } }
            ]}
            expandedRow={(run) => <RunDiff run={run} />}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Canonical vs shadow decisions. Desktop: side by side. Mobile: stacked
 * (Canonical ↓ Shadow ↓ Diff) via .shadow-diff-grid. Long JSON lives in a
 * locally scrolling code block so it can never stretch the viewport.
 */
function RunDiff({ run }: { run: ShadowRun }) {
  const diff = diffLabel(run);
  return (
    <div data-testid={`run-diff-${run.id}`}>
      <div className="shadow-diff-grid">
        <div className="shadow-diff-col">
          <h4>正式（canonical {run.canonical_version}）</h4>
          <pre className="shadow-code" tabIndex={0}>{prettyJson(run.canonical_decision)}</pre>
        </div>
        <div className="shadow-diff-col">
          <h4>候选（shadow {run.shadow_version}）</h4>
          <pre className="shadow-code" tabIndex={0}>{prettyJson(run.shadow_decision)}</pre>
        </div>
      </div>
      {!diff.equal && (
        <div className="shadow-diff-verdict" data-testid={`run-diff-detail-${run.id}`}>
          <h4>差异</h4>
          <pre className="shadow-code" tabIndex={0}>{prettyJson(run.diff_json)}</pre>
        </div>
      )}
    </div>
  );
}
