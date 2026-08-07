import { useEffect, useMemo, useState } from 'react';
import { shadowApi, type ShadowRun } from '../lib/shadowExperiments.js';

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

function decisionPreview(decision: string): string {
  try {
    const parsed = JSON.parse(decision) as Record<string, unknown>;
    return JSON.stringify(parsed).slice(0, 140);
  } catch {
    return decision.slice(0, 140);
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
      {notice && <div className={`admin-notice ${noticeKind === 'error' ? 'admin-notice-error' : ''}`} role="status">{notice}</div>}
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
          <table className="admin-table" data-testid="shadow-run-table">
            <thead>
              <tr><th>子系统</th><th>采样</th><th>有差异</th></tr>
            </thead>
            <tbody>
              {[...stats.bySubsystem.entries()].map(([key, entry]) => (
                <tr key={key}>
                  <td>{SUBSYSTEM_LABELS[key] ?? key}</td>
                  <td>{entry.total}</td>
                  <td>{entry.diff}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="admin-form-card">
        <h3>最近采样</h3>
        {!runs ? <p>加载中…</p> : runs.length === 0 ? <p>暂无采样。开启 SHADOW_MODE_ENABLED 后，生活活动与位置选择会在这里留下对比记录。</p> : (
          <table className="admin-table">
            <thead>
              <tr><th>时间</th><th>子系统</th><th>正式版</th><th>候选版</th><th>结果</th><th>正式决策</th><th>候选决策</th></tr>
            </thead>
            <tbody>
              {runs.slice(0, 50).map((run) => {
                const diff = diffLabel(run);
                return (
                  <tr key={run.id}>
                    <td>{new Date(run.created_at).toLocaleString()}</td>
                    <td>{SUBSYSTEM_LABELS[run.subsystem] ?? run.subsystem}</td>
                    <td>{run.canonical_version}</td>
                    <td>{run.shadow_version}</td>
                    <td className={diff.equal ? '' : 'text-danger'}>{diff.text}</td>
                    <td title={run.canonical_decision}>{decisionPreview(run.canonical_decision)}</td>
                    <td title={run.shadow_decision}>{decisionPreview(run.shadow_decision)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
