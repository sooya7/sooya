import { useEffect, useMemo, useState } from 'react';
import { shadowApi, type Experiment } from '../lib/shadowExperiments.js';

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
      {notice && <div className={`admin-notice ${noticeKind === 'error' ? 'admin-notice-error' : ''}`} role="status">{notice}</div>}

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
        <button className="admin-button" disabled={busy} onClick={() => void create()}>创建草稿</button>
      </section>

      <section className="admin-form-card">
        <h3>实验列表 {summary ? `（共 ${summary.total} · 运行 ${summary.running} · 采样 ${summary.shadow}）` : ''}</h3>
        {!experiments ? <p>加载中…</p> : experiments.length === 0 ? <p>还没有实验。创建后会先以草稿状态出现。</p> : (
          <table className="admin-table" data-testid="experiment-table">
            <thead>
              <tr><th>名称</th><th>子系统</th><th>变体</th><th>状态</th><th>当前变体</th><th>范围</th><th>操作</th></tr>
            </thead>
            <tbody>
              {experiments.map((experiment) => (
                <tr key={experiment.id}>
                  <td>{experiment.name}</td>
                  <td>{SUBSYSTEM_LABELS[experiment.subsystem] ?? experiment.subsystem}</td>
                  <td>{experiment.variants?.join(' / ')}</td>
                  <td>{STATUS_LABELS[experiment.status] ?? experiment.status}</td>
                  <td>{experiment.currentVariant ?? '—'}</td>
                  <td>{SCOPE_LABELS[experiment.assignment_scope] ?? experiment.assignment_scope}</td>
                  <td>
                    {experiment.status === 'draft' && <button className="admin-button" disabled={busy} onClick={() => void transition(experiment, 'shadow')}>开始 Shadow</button>}
                    {experiment.status === 'shadow' && <button className="admin-button" disabled={busy} onClick={() => void transition(experiment, 'running', '正式运行后该子系统将消费实验变体，确认？')}>正式运行</button>}
                    {(experiment.status === 'shadow' || experiment.status === 'running') && <button className="admin-button" disabled={busy} onClick={() => void transition(experiment, 'paused')}>暂停</button>}
                    {(experiment.status === 'paused' || experiment.status === 'running') && <button className="admin-button" disabled={busy} onClick={() => void transition(experiment, 'completed', '完成后该实验结束，确认？')}>完成</button>}
                    {(experiment.status === 'draft' || experiment.status === 'paused' || experiment.status === 'shadow') && <button className="admin-button" disabled={busy} onClick={() => void transition(experiment, 'cancelled', '取消后不可恢复，确认？')}>取消</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
