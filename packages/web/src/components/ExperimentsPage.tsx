import { useEffect, useMemo, useState } from 'react';
import { shadowApi, type Experiment } from '../lib/shadowExperiments.js';
import { adminApi, type ExperimentHistoryEntry, type ExperimentReport } from '../lib/admin.js';
import { AdminNotice, AdminState, adminStateFromError } from './admin/AdminState.js';
import { DataList } from './admin/DataList.js';

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  shadow: 'Shadow 采样中',
  running: '正式运行',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消'
};

const SCOPE_LABELS: Record<string, string> = { day: '按天', session: '按会话', conversation: '按对话' };

const SUBSYSTEM_OPTIONS = ['life.continuity_weight', 'life.anti_repeat_window'];
const SUBSYSTEM_LABELS: Record<string, string> = {
  'life.continuity_weight': '生活连续性权重',
  'life.anti_repeat_window': '防重复窗口'
};

export default function ExperimentsPage() {
  const [experiments, setExperiments] = useState<Experiment[] | null>(null);
  const [name, setName] = useState('');
  const [subsystem, setSubsystem] = useState(SUBSYSTEM_OPTIONS[0]!);
  const [variants, setVariants] = useState('x1,x1.5');
  const [assignmentScope, setAssignmentScope] = useState('day');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error'>('ok');

  const load = () => {
    shadowApi.experiments()
      .then((result) => { setExperiments(result.experiments); setNotice(''); })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : '加载失败');
        setNoticeKind('error');
      });
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name.trim() || variants.split(',').filter((v) => v.trim()).length < 2) {
      setNotice('需要名称和至少 2 个用逗号分隔的变体');
      setNoticeKind('error');
      return;
    }
    setBusy(true);
    try {
      await shadowApi.createExperiment({
        name: name.trim(),
        subsystem,
        variants: variants.split(',').map((v) => v.trim()).filter(Boolean),
        assignmentScope
      });
      setName(''); setVariants('x1,x1.5');
      setNotice('实验已创建（草稿）。先进入 Shadow 采样，再决定是否正式运行。');
      setNoticeKind('ok');
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '创建失败');
      setNoticeKind('error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Lifecycle transitions keep window.confirm for the danger ops (cancel /
   * complete): the next-phase e2e drives them through Playwright's dialog
   * handler. Buttons are grouped per row (.data-list-actions) with a visual
   * separator before the destructive pair.
   */
  const transition = async (experiment: Experiment, status: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await shadowApi.setExperimentStatus(experiment.id, status);
      load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败');
      setNoticeKind('error');
    } finally {
      setBusy(false);
    }
  };

  const summary = useMemo(() => {
    if (!experiments) return null;
    return {
      total: experiments.length,
      running: experiments.filter((e) => e.status === 'running').length,
      shadow: experiments.filter((e) => e.status === 'shadow').length
    };
  }, [experiments]);

  return (
    <div className="admin-page" data-testid="experiments-page">
      <div className="admin-panel-heading">
        <div>
          <h2>实验（A/B）</h2>
          <p>单用户实验框架：草稿 → Shadow 采样（只读对比，不改变行为）→ 正式运行（按天/会话/对话固定变体）→ 暂停（立即回滚到正式行为）→ 完成/取消。</p>
        </div>
      </div>
      {notice && <AdminNotice kind={noticeKind}>{notice}</AdminNotice>}

      <section className="admin-form-card">
        <h3>新建实验</h3>
        <div className="admin-summary">
          <label className="admin-card"><strong>名称</strong><input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：连续性权重 1.5" /></label>
          <label className="admin-card">
            <strong>子系统</strong>
            <select value={subsystem} onChange={(e) => setSubsystem(e.target.value)}>
              {SUBSYSTEM_OPTIONS.map((value) => <option key={value} value={value}>{SUBSYSTEM_LABELS[value]}</option>)}
            </select>
          </label>
          <label className="admin-card"><strong>变体（逗号分隔）</strong><input value={variants} onChange={(e) => setVariants(e.target.value)} placeholder="x1,x1.5" /></label>
          <label className="admin-card">
            <strong>分配范围</strong>
            <select value={assignmentScope} onChange={(e) => setAssignmentScope(e.target.value)}>
              {Object.entries(SCOPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
        <div className="admin-actions">
          <button className="admin-button primary" disabled={busy} onClick={() => void create()}>创建草稿</button>
        </div>
      </section>

      <section className="admin-form-card">
        <h3>实验列表 {summary ? `（共 ${summary.total} · 运行 ${summary.running} · 采样 ${summary.shadow}）` : ''}</h3>
        {!experiments ? <AdminState kind="loading" /> : experiments.length === 0 ? (
          <AdminState kind="empty" message="还没有实验。创建后会先以草稿状态出现。" />
        ) : (
          <DataList<Experiment>
            testId="experiment-table"
            rows={experiments}
            rowKey={(e) => e.id}
            expandable
            columns={[
              { key: 'name', label: '名称', render: (e) => e.name },
              { key: 'subsystem', label: '子系统', render: (e) => SUBSYSTEM_LABELS[e.subsystem] ?? e.subsystem },
              { key: 'variants', label: '变体', mobileCollapsed: true, render: (e) => e.variants?.join(' / ') ?? '—' },
              { key: 'status', label: '状态', render: (e) => STATUS_LABELS[e.status] ?? e.status },
              { key: 'current', label: '当前变体', mobileCollapsed: true, render: (e) => e.currentVariant ?? '—' },
              { key: 'scope', label: '范围', mobileCollapsed: true, render: (e) => SCOPE_LABELS[e.assignment_scope] ?? e.assignment_scope }
            ]}
            actions={(experiment) => (
              <>
                {experiment.status === 'draft' && <button className="admin-button" disabled={busy} onClick={() => void transition(experiment, 'shadow')}>开始 Shadow</button>}
                {experiment.status === 'shadow' && <button className="admin-button" disabled={busy} onClick={() => void transition(experiment, 'running', '正式运行后该子系统将消费实验变体，确认？')}>正式运行</button>}
                {(experiment.status === 'shadow' || experiment.status === 'running') && <button className="admin-button" disabled={busy} onClick={() => void transition(experiment, 'paused')}>暂停</button>}
                {(experiment.status === 'paused' || experiment.status === 'running') && (
                  <>
                    <span className="danger-sep" aria-hidden="true" />
                    <button className="admin-button admin-danger" disabled={busy} onClick={() => void transition(experiment, 'completed', '完成后该实验结束，确认？')}>完成</button>
                  </>
                )}
                {(experiment.status === 'draft' || experiment.status === 'paused' || experiment.status === 'shadow') && (
                  <>
                    <span className="danger-sep" aria-hidden="true" />
                    <button className="admin-button admin-danger" disabled={busy} onClick={() => void transition(experiment, 'cancelled', '取消后不可恢复，确认？')}>取消</button>
                  </>
                )}
              </>
            )}
            expandedRow={(experiment) => <ExperimentDetails experiment={experiment} />}
          />
        )}
      </section>
    </div>
  );
}

const HISTORY_EVENT_LABELS: Record<string, string> = {
  created: '创建',
  shadow: '进入 Shadow',
  promoted: '正式运行',
  paused: '暂停',
  resumed: '恢复',
  completed: '完成',
  config_changed: '配置变更'
};

/**
 * Report + audit timeline for one experiment (frozen contract §2). Loaded only
 * when the row is expanded, so the list stays light.
 */
function ExperimentDetails({ experiment }: { experiment: Experiment }) {
  const [report, setReport] = useState<ExperimentReport | null | undefined>(undefined);
  const [history, setHistory] = useState<ExperimentHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void adminApi.experimentReport(experiment.id)
      .then((body) => { if (alive) setReport(body.report); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    void adminApi.experimentHistory(experiment.id)
      .then((body) => { if (alive) setHistory(body.history); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [experiment.id]);

  if (error) {
    const state = adminStateFromError(error);
    return <AdminState kind={state.kind} message={error} />;
  }
  return (
    <div className="experiment-details" data-testid={`experiment-details-${experiment.id}`}>
      <div className="experiment-details-grid">
        <div>
          <h4>Report</h4>
          {report === undefined ? <AdminState kind="loading" /> : report === null ? (
            <AdminState kind="empty" message="暂无样本。进入 Shadow 采样后会积累对照数据。" />
          ) : (
            <dl className="weather-kv">
              <dt>样本数</dt><dd>{report.samples}</dd>
              <dt>Control</dt><dd>{report.control}</dd>
              <dt>Treatment</dt><dd>{report.treatment}</dd>
            </dl>
          )}
          {report && report.observedDifference.length > 0 && (
            <table className="data-list experiment-diff-table">
              <thead>
                <tr><th>指标</th><th>Control</th><th>Treatment</th></tr>
              </thead>
              <tbody>
                {report.observedDifference.map((row) => (
                  <tr key={row.metric}>
                    <td data-label="指标">{row.metric}</td>
                    <td data-label="Control">{row.control}</td>
                    <td data-label="Treatment">{row.treatment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h4>历史（audit）</h4>
          {history === null ? <AdminState kind="loading" /> : history.length === 0 ? (
            <AdminState kind="empty" message="暂无审计事件" />
          ) : (
            <ol className="history-timeline" data-testid={`experiment-history-${experiment.id}`}>
              {[...history].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((entry) => (
                <li key={entry.id}>
                  <span className="history-event">{HISTORY_EVENT_LABELS[entry.event] ?? entry.event}</span>
                  <span className="muted">{entry.variant || '—'} · {new Date(entry.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
