import { useCallback, useEffect, useRef, useState } from 'react';
import { adminRequest } from '../lib/admin.js';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';
import { formatAdminDateTime } from '../lib/adminDisplay.js';

export type VideoTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface VideoTask {
  id: string;
  mode: 'text' | 'image';
  prompt: string;
  status: VideoTaskStatus;
  progress: number | null;
  provider: string;
  model: string;
  params: Record<string, unknown>;
  sourceMedia: { id: string; url: string } | null;
  media: { id: string; url: string; mime: string; bytes: number } | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const VIDEO_STATUS_LABELS: Record<VideoTaskStatus, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

const ACTIVE = new Set<VideoTaskStatus>(['queued', 'running']);
const POLL_MS = 3000;

export interface VideoPolicy {
  enabled: boolean;
  frequency: 'never' | 'low' | 'medium' | 'high';
  maxPerDay: number;
}

export const VIDEO_FREQUENCY_LABELS: Record<VideoPolicy['frequency'], string> = {
  never: '只在用户明确要求时',
  low: '偶尔主动',
  medium: '适度主动',
  high: '经常主动'
};

export const videoApi = {
  overview: () => adminRequest<{ policy?: VideoPolicy }>('/api/admin/video'),
  savePolicy: (policy: Partial<VideoPolicy>) => adminRequest<{ policy: VideoPolicy }>('/api/admin/video', { method: 'PUT', body: { policy } }),
  list: () => adminRequest<{ tasks: VideoTask[]; total: number; active: number }>('/api/admin/video/generations?limit=20'),
  create: (form: FormData) => adminRequest<{ task: VideoTask }>('/api/admin/video/generations', { method: 'POST', body: form }),
  cancel: (id: string) => adminRequest<{ task: VideoTask }>(`/api/admin/video/generations/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  remove: (id: string) => adminRequest<{ deleted: boolean }>(`/api/admin/video/generations/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

function VideoPlayer({ path }: { path: string }) {
  const { url, error, loading } = useAuthenticatedMedia(path, 'admin', 'file');
  if (error) return <span role="status" title={error}>视频不可用</span>;
  if (!url) return <span className="admin-muted">{loading ? '正在加载视频…' : ''}</span>;
  return <video className="admin-video-preview" src={url} controls preload="metadata" />;
}

/**
 * 文生视频 / 图生视频 workbench inside the model panel. The same task list the
 * API exposes is shown here, so what an operator sees in the browser and what
 * a script sees over HTTP never disagree.
 */
export function VideoStudio({ onNotice }: { onNotice: (v: string) => void }) {
  const [tasks, setTasks] = useState<VideoTask[] | null>(null);
  const [prompt, setPrompt] = useState('');
  const [durationSec, setDurationSec] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [policy, setPolicy] = useState<VideoPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void videoApi.overview().then((r) => { if (r && r.policy) setPolicy(r.policy); }).catch(() => undefined);
  }, []);

  const savePolicy = async () => {
    if (!policy) return;
    setSavingPolicy(true);
    try {
      const r = await videoApi.savePolicy(policy);
      setPolicy(r.policy);
      onNotice('聊天里的视频策略已保存');
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      setSavingPolicy(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const r = await videoApi.list();
      setTasks(r.tasks);
    } catch (e) {
      onNotice(errorText(e));
    }
  }, [onNotice]);

  useEffect(() => { void load(); }, [load]);

  // Poll only while something is still owed a result; idle lists stay quiet.
  const hasActive = (tasks ?? []).some((task) => ACTIVE.has(task.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  const submit = async () => {
    const text = prompt.trim();
    if (!text) { onNotice('先写一句视频描述'); return; }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set('prompt', text);
      if (durationSec.trim()) form.set('durationSec', durationSec.trim());
      if (file) form.set('image', file, file.name);
      const r = await videoApi.create(form);
      setTasks((prev) => [r.task, ...(prev ?? [])]);
      setPrompt('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      onNotice(file ? '图生视频任务已提交' : '文生视频任务已提交');
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      const r = await videoApi.cancel(id);
      setTasks((prev) => (prev ?? []).map((task) => (task.id === id ? r.task : task)));
    } catch (e) {
      onNotice(errorText(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await videoApi.remove(id);
      setTasks((prev) => (prev ?? []).filter((task) => task.id !== id));
    } catch (e) {
      onNotice(errorText(e));
    }
  };

  return (
    <section className="admin-card admin-form-wide admin-video-studio" data-testid="admin-video-studio">
      <div className="admin-card-heading">
        <h3>视频生成</h3>
        <small>不带图是文生视频，带一张参考图就是图生视频。任务在后台执行，完成后可在这里播放，文件也进入媒体库。</small>
      </div>
      {policy && (
        <div className="admin-video-policy" data-testid="admin-video-policy">
          <div className="admin-card-heading">
            <h3>聊天里的视频</h3>
            <small>她在回复里写 [[video:…]] 或 [[video-self:…]] 就会排队生成，做好后作为一条新消息单独发出。每条视频都要计费，所以默认只在用户明确要求时才做。</small>
          </div>
          <label><span>允许在聊天里发视频</span><input type="checkbox" checked={policy.enabled} onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })} /></label>
          <label>
            主动频率
            <select value={policy.frequency} onChange={(e) => setPolicy({ ...policy, frequency: e.target.value as VideoPolicy['frequency'] })}>
              {(Object.keys(VIDEO_FREQUENCY_LABELS) as VideoPolicy['frequency'][]).map((key) => <option key={key} value={key}>{VIDEO_FREQUENCY_LABELS[key]}</option>)}
            </select>
          </label>
          <label>24 小时内最多生成（条）<input type="number" min="0" max="50" value={policy.maxPerDay} onChange={(e) => setPolicy({ ...policy, maxPerDay: Number(e.target.value) })} /></label>
          <div className="admin-actions"><button type="button" data-testid="admin-video-policy-save" disabled={savingPolicy} onClick={() => void savePolicy()}>{savingPolicy ? '保存中…' : '保存视频策略'}</button></div>
        </div>
      )}
      <label>视频描述<textarea value={prompt} rows={3} placeholder="例如：海边日落，镜头缓慢推进，海鸟掠过水面" onChange={(e) => setPrompt(e.target.value)} /></label>
      <label>
        参考图（可选，图生视频）
        <input ref={fileInput} type="file" accept="image/*" data-testid="admin-video-image" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <small>{file ? `将以「${file.name}」作为首帧` : '留空则按文字生成'}</small>
      </label>
      <label>时长（秒，可选）<input type="number" min="1" max="60" value={durationSec} placeholder="用模型配置里的默认值" onChange={(e) => setDurationSec(e.target.value)} /></label>
      <div className="admin-actions">
        <button type="button" data-testid="admin-video-submit" disabled={submitting} onClick={() => void submit()}>{submitting ? '提交中…' : file ? '生成视频（图生视频）' : '生成视频（文生视频）'}</button>
        <button type="button" onClick={() => void load()}>刷新列表</button>
      </div>
      <details className="admin-form-wide">
        <summary className="admin-muted">通过 API 调用</summary>
        <pre className="admin-code">{`# 文生视频
curl -X POST $BASE/api/admin/video/generations \\
  -H "X-Admin-Token: $ADMIN_API_TOKEN" -H "content-type: application/json" \\
  -d '{"prompt":"海边日落，慢镜头","durationSec":5}'

# 图生视频（上传首帧）
curl -X POST $BASE/api/admin/video/generations \\
  -H "X-Admin-Token: $ADMIN_API_TOKEN" \\
  -F prompt="让画面动起来" -F image=@first-frame.png

# 查询进度；完成后 task.media.url 就是视频地址
curl $BASE/api/admin/video/generations/<taskId> -H "X-Admin-Token: $ADMIN_API_TOKEN"`}</pre>
      </details>
      {tasks === null ? <p className="admin-muted">正在读取任务…</p> : tasks.length === 0 ? <p className="admin-muted">还没有视频任务。</p> : (
        <ul className="admin-video-tasks" data-testid="admin-video-tasks">
          {tasks.map((task) => (
            <li key={task.id} className="admin-video-task" data-status={task.status}>
              <div className="admin-video-task-head">
                <strong>{VIDEO_STATUS_LABELS[task.status]}{task.status === 'running' && task.progress != null ? ` · ${task.progress}%` : ''}</strong>
                <small>{task.mode === 'image' ? '图生视频' : '文生视频'} · {task.model} · {formatAdminDateTime(task.createdAt)}</small>
              </div>
              <p>{task.prompt}</p>
              {task.error ? <p className="admin-test-result fail">{task.error}</p> : null}
              {task.status === 'succeeded' && task.media ? <VideoPlayer path={task.media.url} /> : null}
              <div className="admin-actions">
                {ACTIVE.has(task.status)
                  ? <button type="button" onClick={() => void cancel(task.id)}>取消</button>
                  : <button type="button" className="subtle" onClick={() => void remove(task.id)}>删除记录</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
