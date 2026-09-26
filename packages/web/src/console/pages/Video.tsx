import { useEffect, useRef, useState } from 'react';
import { adminRequest } from '../../lib/admin.js';
import { featureApi } from '../../lib/features.js';
import { useAuthenticatedMedia } from '../../lib/useAuthenticatedMedia.js';
import { consolePath } from '../routes.js';
import {
  Button, Callout, ConfirmButton, Empty, Facts, Field, Fields, Input, Loadable, Loading, Meter, Page, Section, Select, Status, Switch, Tag, TextArea,
  errorMessage, fmtAgo, fmtBytes, fmtTime, useAction, useConsole, useLoad, type Loaded, type Tone
} from '../ui.js';
import { PaidButton, Thumb, downloadMedia, explain, usePaged, type Paged } from './Media/shared.js';
import './Media.css';
import './Video.css';

/* ------------------------------------------------------------- api */

type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

interface MediaRef { id: string; url: string; mime: string; bytes: number; kind?: string; duration?: number | null }

interface VideoTask {
  id: string;
  mode: 'text' | 'image';
  prompt: string;
  status: TaskStatus;
  progress: number | null;
  provider: string;
  model: string;
  params: Record<string, unknown>;
  origin: { kind: 'admin' | 'reply' | 'proactive'; intent?: string } | null;
  sourceMedia: MediaRef | null;
  media: MediaRef | null;
  error: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt: string | null;
}

interface VideoPolicy { enabled: boolean; frequency: 'never' | 'low' | 'medium' | 'high'; maxPerDay: number }

interface VideoOverview {
  capability?: { configured?: boolean; ok?: boolean; provider?: string; detail?: string; checkedAt?: string };
  model?: { provider?: string; model?: string; baseUrl?: string; size?: string; durationSec?: number; maxActiveTasks?: number; apiKeyConfigured?: boolean };
  policy?: VideoPolicy;
  active?: number;
  total?: number;
}

const videoApi = {
  overview: () => adminRequest<VideoOverview>('/api/admin/video'),
  savePolicy: (policy: VideoPolicy) => adminRequest<{ policy: VideoPolicy }>('/api/admin/video', { method: 'PUT', body: { policy } }),
  list: (query: { limit: number; offset: number; status?: TaskStatus }) => {
    const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
    if (query.status) params.set('status', query.status);
    return adminRequest<{ tasks: VideoTask[]; total: number; active: number }>(`/api/admin/video/generations?${params}`);
  },
  create: (body: FormData | Record<string, unknown>) => adminRequest<{ task: VideoTask }>('/api/admin/video/generations', { method: 'POST', body }),
  cancel: (id: string) => adminRequest<{ task: VideoTask }>(`/api/admin/video/generations/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  remove: (id: string) => adminRequest<{ deleted: boolean }>(`/api/admin/video/generations/${encodeURIComponent(id)}`, { method: 'DELETE' })
};

const STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  queued: { label: '排队中', tone: 'warn' },
  running: { label: '生成中', tone: 'warn' },
  succeeded: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'off' }
};
const ACTIVE = new Set<TaskStatus>(['queued', 'running']);
const POLL_MS = 3000;
const PAGE = 20;

const FREQUENCY_OPTIONS = [
  { value: 'never', label: '只在你明确要她拍的时候' },
  { value: 'low', label: '偶尔主动发一条' },
  { value: 'medium', label: '适度主动' },
  { value: 'high', label: '经常主动' }
];
const RATIO_OPTIONS = [
  { value: '', label: '按模型默认' },
  { value: '16:9', label: '横屏 16:9' },
  { value: '9:16', label: '竖屏 9:16' },
  { value: '1:1', label: '方形 1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' }
];
const ORIGIN_TEXT: Record<string, string> = { admin: '在这里提交的', reply: '她在聊天里拍的', proactive: '她主动拍的' };

/* ------------------------------------------------------------ page */

export default function Video() {
  const overview = useLoad(() => videoApi.overview());
  const ready = Boolean(overview.data?.capability?.configured);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('');
  const list = usePaged<VideoTask>(async (offset, limit) => {
    const result = await videoApi.list({ limit, offset, status: statusFilter || undefined });
    return { items: result.tasks, total: result.total, extra: { active: result.active } };
  }, PAGE, [statusFilter]);

  return (
    <Page title="视频生成" register="system" intro="文生视频和图生视频。每一条都会调用付费的视频模型，按条计费。">
      <div className="video-page">
      <ModelSection state={overview} />
      <PolicySection state={overview} />
      <CreateSection ready={ready} loaded={overview.data !== null} defaults={overview.data?.model} onCreated={() => void list.reload()} />
      <TaskSection list={list} statusFilter={statusFilter} onStatusFilter={setStatusFilter} />
      <Section title="用接口提交" desc="写脚本批量生成时用，需要管理令牌。">
        <pre className="cs-code">{`# 文生视频
curl -X POST $BASE/api/admin/video/generations \\
  -H "X-Admin-Token: $ADMIN_API_TOKEN" -H "content-type: application/json" \\
  -d '{"prompt":"海边日落，慢镜头","durationSec":5,"aspectRatio":"16:9"}'

# 图生视频：上传首帧
curl -X POST $BASE/api/admin/video/generations \\
  -H "X-Admin-Token: $ADMIN_API_TOKEN" \\
  -F prompt="让画面动起来" -F image=@first-frame.png

# 查进度；完成后 task.media.url 就是视频地址
curl $BASE/api/admin/video/generations/<任务 ID> -H "X-Admin-Token: $ADMIN_API_TOKEN"`}</pre>
      </Section>
      </div>
    </Page>
  );
}

/* ----------------------------------------------------------- model */

function ModelSection({ state }: { state: Loaded<VideoOverview> }) {
  const { navigate } = useConsole();
  return (
    <Section title="视频模型" desc="用哪家的模型、默认多长多大，在模型页面里改。">
      <Loadable state={state} label="视频模型状态">
        {(data) => {
          const cap = data.capability ?? {};
          const model = data.model ?? {};
          const tone: Tone = cap.configured ? (cap.ok === false ? 'warn' : 'ok') : 'bad';
          return (
            <>
              <div className="cs-actions" style={{ justifyContent: 'space-between' }}>
                <Status tone={tone}>
                  {cap.configured ? (cap.ok === false ? `已配置，但最近一次检查不通过${cap.detail ? `：${cap.detail}` : ''}` : '已配置，可以生成') : '还没有配置视频模型'}
                </Status>
                <span className="cs-actions">
                  <Button kind="text" size="sm" busy={state.loading} onClick={() => void state.reload()}>刷新</Button>
                  <Button kind="quiet" size="sm" onClick={() => navigate(consolePath('models'))}>去配置模型</Button>
                </span>
              </div>
              {!cap.configured && <Callout tone="warn">没配置之前不能生成视频，她在聊天里也拍不了。接口地址、模型名和密钥缺一不可。</Callout>}
              <Facts items={[
                ['服务', model.provider && model.provider !== 'none' ? model.provider : '没有'],
                ['模型', model.model || '—'],
                ['默认分辨率', model.size || '—'],
                ['默认时长', model.durationSec ? `${model.durationSec} 秒` : '—'],
                ['最多同时进行', model.maxActiveTasks ? `${model.maxActiveTasks} 个` : '—'],
                ['进行中 / 总共', `${data.active ?? 0} / ${data.total ?? 0}`]
              ]} />
            </>
          );
        }}
      </Loadable>
    </Section>
  );
}

/* ---------------------------------------------------------- policy */

function PolicySection({ state }: { state: Loaded<VideoOverview> }) {
  const { markClean } = useConsole();
  const { run, busy } = useAction();
  type Draft = Omit<VideoPolicy, 'maxPerDay'> & { maxPerDay: string };
  const toDraft = (policy: VideoPolicy): Draft => ({ ...policy, maxPerDay: String(policy.maxPerDay) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const saved = state.data?.policy ? toDraft(state.data.policy) : null;
  useEffect(() => { if (saved && !draft) setDraft(saved); }, [saved, draft]);

  const max = draft ? Number(draft.maxPerDay) : 0;
  const maxError = draft && (draft.maxPerDay.trim() === '' || !Number.isInteger(max) || max < 0 || max > 50) ? '填 0 到 50 之间的整数。' : null;

  const save = () => run('policy', async () => {
    if (!draft || maxError) return;
    const result = await explain(videoApi.savePolicy({ enabled: draft.enabled, frequency: draft.frequency, maxPerDay: max }));
    setDraft(toDraft(result.policy));
    state.setData((old) => (old ? { ...old, policy: result.policy } : old));
    markClean();
  }, '视频策略已保存');

  const changed = Boolean(draft && saved && (draft.enabled !== saved.enabled || draft.frequency !== saved.frequency || Number(draft.maxPerDay) !== Number(saved.maxPerDay) || draft.maxPerDay.trim() === ''));

  return (
    <Section title="聊天里的视频" desc="她在回复里决定拍一段视频时，会在后台排队生成，做好后作为一条新消息单独发给你。每条都要计费，所以默认只在你开口要的时候才拍。">
      {state.error !== null && state.data === null ? <p className="cs-muted">读不到当前的设置，先在上面刷新。</p> : !draft ? <Loading /> : (
        <>
          <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label={draft.enabled ? '允许她在聊天里发视频' : '不允许她在聊天里发视频'} />
          <Fields>
            <Field label="她会主动拍视频的频率">
              <Select value={draft.frequency} disabled={!draft.enabled} options={FREQUENCY_OPTIONS} onChange={(e) => setDraft({ ...draft, frequency: e.target.value as VideoPolicy['frequency'] })} />
            </Field>
            <Field label="24 小时内最多拍几条" error={maxError} hint="0 到 50。到了上限，她这一天就不再拍了。">
              <Input type="number" min={0} max={50} step={1} value={draft.maxPerDay} disabled={!draft.enabled}
                onChange={(e) => setDraft({ ...draft, maxPerDay: e.target.value })} />
            </Field>
          </Fields>
          <div className="cs-actions">
            <Button busy={busy === 'policy'} disabled={!changed || Boolean(maxError)} onClick={() => void save()}>保存视频策略</Button>
            {changed && <Button kind="text" size="sm" onClick={() => { setDraft(saved); markClean(); }}>撤销改动</Button>}
          </div>
        </>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------- create */

type Source = 'none' | 'upload' | 'album' | 'url';

function CreateSection({ ready, loaded, defaults, onCreated }: {
  ready: boolean; loaded: boolean; defaults?: VideoOverview['model']; onCreated: () => void;
}) {
  const { markClean } = useConsole();
  const { run, busy } = useAction();
  const [prompt, setPrompt] = useState('');
  const [source, setSource] = useState<Source>('none');
  const [file, setFile] = useState<File | null>(null);
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [duration, setDuration] = useState('');
  const [ratio, setRatio] = useState('');
  const [size, setSize] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  const durationNumber = duration.trim() ? Number(duration) : null;
  const durationError = durationNumber !== null && (!Number.isInteger(durationNumber) || durationNumber < 1 || durationNumber > 60) ? '时长要是 1 到 60 之间的整数。' : null;
  const urlError = source === 'url' && imageUrl.trim() && !/^https?:\/\/\S+$/i.test(imageUrl.trim()) ? '要以 http:// 或 https:// 开头。' : null;
  const missing = !prompt.trim()
    ? '先写一句视频描述。'
    : source === 'upload' && !file ? '选一张参考图，或者改成不用参考图。'
      : source === 'album' && !mediaId ? '从相册里点一张参考图。'
        : source === 'url' && !imageUrl.trim() ? '填上参考图的地址。'
          : durationError ?? urlError;
  const imageMode = source !== 'none';

  const submit = () => run('create', async () => {
    const common = {
      prompt: prompt.trim(),
      ...(durationNumber ? { durationSec: durationNumber } : {}),
      ...(size.trim() ? { size: size.trim() } : {}),
      ...(ratio ? { aspectRatio: ratio } : {})
    };
    let body: FormData | Record<string, unknown>;
    if (source === 'upload' && file) {
      const form = new FormData();
      for (const [key, value] of Object.entries(common)) form.set(key, String(value));
      form.set('image', file, file.name);
      body = form;
    } else {
      body = { ...common, ...(source === 'album' && mediaId ? { imageMediaId: mediaId } : {}), ...(source === 'url' ? { imageUrl: imageUrl.trim() } : {}) };
    }
    await explain(videoApi.create(body));
    setPrompt('');
    setFile(null);
    setMediaId(null);
    setImageUrl('');
    if (fileInput.current) fileInput.current.value = '';
    markClean();
    onCreated();
  }, imageMode ? '图生视频任务已提交' : '文生视频任务已提交');

  return (
    <Section title="生成一段视频" desc="不带图是文生视频；给一张参考图当第一帧，就是图生视频。任务在后台跑，通常要几分钟，做好的视频也会进相册的全部媒体里。">
      {loaded && !ready && <Callout tone="warn">视频模型还没配置好，现在提交会直接失败。</Callout>}
      <Fields>
        <Field label="视频描述" full hint={`写清楚画面、动作和镜头。${prompt.length}/2000`}>
          <TextArea value={prompt} rows={3} maxLength={2000} placeholder="例如：海边日落，镜头缓慢推进，海鸟掠过水面" onChange={(e) => setPrompt(e.target.value)} />
        </Field>
      </Fields>
      <div className="cs-field">
        <span className="cs-field-label">参考图</span>
        <div className="video-choices" role="radiogroup" aria-label="参考图">
          {([['none', '不用参考图'], ['upload', '上传一张'], ['album', '从相册里选'], ['url', '网络图片地址']] as Array<[Source, string]>).map(([value, label]) => (
            <label className="cs-choice" key={value}>
              <input type="radio" name="video-source" checked={source === value} onChange={() => setSource(value)} />
              {label}
            </label>
          ))}
        </div>
      </div>
      {source === 'upload' && (
        <Field label="上传参考图" hint={file ? `会用「${file.name}」（${fmtBytes(file.size)}）当第一帧。` : '支持常见图片格式。'}>
          <input ref={fileInput} className="cs-input" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
      )}
      {source === 'album' && <AlbumPicker value={mediaId} onChange={setMediaId} />}
      {source === 'url' && (
        <Field label="图片地址" error={urlError} hint="服务器会去下载这张图，内网地址会被拒绝。">
          <Input type="url" value={imageUrl} placeholder="https://…" onChange={(e) => setImageUrl(e.target.value)} />
        </Field>
      )}
      <Fields>
        <Field label="时长（秒）" error={durationError} hint={defaults?.durationSec ? `留空用默认的 ${defaults.durationSec} 秒。` : '留空用模型默认值。'}>
          <Input type="number" min={1} max={60} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </Field>
        <Field label="画面比例"><Select value={ratio} options={RATIO_OPTIONS} onChange={(e) => setRatio(e.target.value)} /></Field>
        <Field label="分辨率" hint={defaults?.size ? `留空用默认的 ${defaults.size}。` : '留空用模型默认值。'}>
          <Input value={size} maxLength={20} placeholder={defaults?.size || '1280x720'} onChange={(e) => setSize(e.target.value)} />
        </Field>
      </Fields>
      <div className="cs-actions">
        <PaidButton
          kind="primary"
          size="md"
          label={imageMode ? '生成视频（图生视频，消耗额度）' : '生成视频（文生视频，消耗额度）'}
          question="会调用视频模型生成一条视频，按条计费。确定提交？"
          confirmLabel="提交生成"
          busy={busy === 'create'}
          disabled={Boolean(missing) || !ready}
          onConfirm={submit}
        />
        {missing && prompt && <span className="cs-muted">{missing}</span>}
      </div>
    </Section>
  );
}

function AlbumPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const gallery = useLoad(() => featureApi.gallery({ limit: 30 }));
  return (
    <div className="cs-field">
      <span className="cs-field-label">从相册里点一张（最近 30 张）</span>
      <Loadable state={gallery} label="相册">
        {(data) => data.media.length === 0 ? <Empty>相册里还没有图片。换成上传一张吧。</Empty> : (
          <div className="cs-grid-media video-pick" role="listbox" aria-label="相册图片">
            {data.media.filter((item) => item.exists).map((item) => (
              <div className="cs-media" key={item.id}>
                <div className="cs-media-frame" data-picked={value === item.id || undefined}>
                  <button type="button" role="option" aria-selected={value === item.id} aria-label={`用 ${fmtTime(item.createdAt)} 的这张`} onClick={() => onChange(value === item.id ? null : item.id)}>
                    <Thumb path={item.url} kind="image" alt="相册图片" width={100} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Loadable>
    </div>
  );
}

/* ----------------------------------------------------------- tasks */

function TaskSection({ list, statusFilter, onStatusFilter }: {
  list: Paged<VideoTask>; statusFilter: TaskStatus | ''; onStatusFilter: (value: TaskStatus | '') => void;
}) {
  const active = list.items.some((task) => ACTIVE.has(task.status));
  const refreshRef = useRef(list.refresh);
  refreshRef.current = list.refresh;
  // Poll only while something is still owed a result.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refreshRef.current(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  return (
    <Section title="生成记录" desc="包括你在这里提交的，和她在聊天里拍的。有任务在进行时，每 3 秒自动刷新一次进度。" wide>
      <div className="cs-actions" style={{ justifyContent: 'space-between' }} data-no-dirty>
        <span className="cs-actions">
          <Select aria-label="按状态筛选" value={statusFilter} style={{ width: 'auto' }} onChange={(e) => onStatusFilter(e.target.value as TaskStatus | '')} options={[
            { value: '', label: '全部状态' },
            ...(Object.keys(STATUS) as TaskStatus[]).map((key) => ({ value: key, label: STATUS[key].label }))
          ]} />
          <span className="cs-muted">{list.total} 条{Number(list.extra.active ?? 0) > 0 ? `，${list.extra.active} 条进行中` : ''}</span>
        </span>
        <Button kind="text" size="sm" busy={list.loading} onClick={() => void list.refresh()}>刷新</Button>
      </div>
      {list.error !== null && (
        <Callout tone="bad">生成记录读取失败：{errorMessage(list.error)} <Button kind="text" size="sm" onClick={() => void list.reload()}>重试</Button></Callout>
      )}
      {list.items.length === 0 && list.loading && <Loading />}
      {list.items.length === 0 && !list.loading && list.error === null && (
        statusFilter
          ? <Empty action={<Button kind="quiet" size="sm" onClick={() => onStatusFilter('')}>看全部记录</Button>}>没有这个状态的任务。</Empty>
          : <Empty>还没有生成过视频。在上面写一句描述就可以开始。</Empty>
      )}
      {list.items.length > 0 && (
        <ul className="video-tasks">
          {list.items.map((task) => <TaskRow key={task.id} task={task} onChanged={() => void list.refresh()} />)}
        </ul>
      )}
      {list.hasMore && <div className="cs-actions"><Button kind="quiet" busy={list.loading} onClick={() => void list.loadMore()}>再加载 {PAGE} 条</Button></div>}
    </Section>
  );
}

function elapsed(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from || !to) return null;
  const s = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000);
  if (!Number.isFinite(s) || s < 0) return null;
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function TaskRow({ task, onChanged }: { task: VideoTask; onChanged: () => void }) {
  const { run, busy } = useAction();
  const status = STATUS[task.status] ?? { label: task.status, tone: 'off' as Tone };
  const isActive = ACTIVE.has(task.status);
  const took = elapsed(task.startedAt ?? task.createdAt, task.completedAt);
  const params = [
    typeof task.params.durationSec === 'number' ? `${task.params.durationSec} 秒` : null,
    typeof task.params.aspectRatio === 'string' ? task.params.aspectRatio : null,
    typeof task.params.size === 'string' ? task.params.size : null
  ].filter(Boolean).join('，');

  const cancel = () => run('cancel', async () => { await explain(videoApi.cancel(task.id)); onChanged(); }, '已取消生成');
  const remove = () => run('remove', async () => { await explain(videoApi.remove(task.id)); onChanged(); }, '记录已删除');

  return (
    <li className="video-task" data-status={task.status}>
      <div className="video-task-head">
        <Status tone={status.tone}>{status.label}</Status>
        <Tag>{task.mode === 'image' ? '图生视频' : '文生视频'}</Tag>
        <span className="cs-list-meta">
          {ORIGIN_TEXT[task.origin?.kind ?? 'admin'] ?? '在这里提交的'}，{fmtAgo(task.createdAt)}{task.model ? `，${task.model}` : ''}{params ? `，${params}` : ''}
        </span>
      </div>
      <div className="video-task-side">
        {isActive
          ? <ConfirmButton label="取消生成" question="取消后不会再出结果，已经扣的额度可能不退。确定？" confirmLabel="取消生成" busy={busy === 'cancel'} onConfirm={cancel} />
          : <ConfirmButton label="删除记录" question={task.media ? '只删这条记录，视频文件还留在全部媒体里。确定？' : '删除这条记录？'} confirmLabel="删除记录" busy={busy === 'remove'} onConfirm={remove} />}
      </div>
      <p className="video-task-prompt">{task.prompt}</p>
      <div className="video-task-body">
        {isActive && (
          task.progress != null
            ? <Meter label={task.status === 'queued' ? '排队中' : '进度'} value={task.progress / 100} display={`${Math.round(task.progress)}%`} />
            : <p className="cs-muted">{task.status === 'queued' ? '在排队，前面的任务做完就轮到它。' : '正在生成，这家模型不报告进度，做好了会自动出现在这里。'}</p>
        )}
        {task.sourceMedia && (
          <div className="video-source">
            <span className="video-source-thumb"><Thumb path={task.sourceMedia.url} kind="image" alt="参考图" width={60} /></span>
            <span className="cs-muted">用这张图当第一帧</span>
          </div>
        )}
        {task.origin?.intent && <p className="cs-muted">她原本想拍的：{task.origin.intent}</p>}
        {task.error && <Callout tone="bad">{task.error}</Callout>}
        {task.status === 'succeeded' && (task.media ? <VideoPlayer media={task.media} /> : <p className="cs-muted">任务显示完成了，但视频文件找不到了。</p>)}
        {task.completedAt && <span className="cs-list-meta">{fmtTime(task.completedAt)} 结束{took ? `，用了 ${took}` : ''}{task.media ? `，${fmtBytes(task.media.bytes)}` : ''}</span>}
      </div>
    </li>
  );
}

function VideoPlayer({ media }: { media: MediaRef }) {
  const { run, busy } = useAction();
  const [load, setLoad] = useState(false);
  const [broken, setBroken] = useState(false);
  const state = useAuthenticatedMedia(load ? media.url : null, 'admin', 'file');
  const download = () => run('download', () => downloadMedia({ id: media.id, url: media.url, kind: 'file', mime: media.mime || 'video/mp4' }));
  if (!load) return <div><Button kind="quiet" size="sm" onClick={() => setLoad(true)}>播放视频（{fmtBytes(media.bytes)}）</Button></div>;
  if (state.error) {
    return (
      <Callout tone="bad">
        视频读不出来：{state.error}
        {state.retriable && <> <Button kind="text" size="sm" onClick={state.retry}>重试</Button></>}
      </Callout>
    );
  }
  if (!state.url) return <Loading>正在读取视频…</Loading>;
  if (broken) {
    return (
      <Callout tone="warn">
        浏览器放不了这个格式，下载下来用播放器看。{' '}
        <Button kind="text" size="sm" busy={busy === 'download'} onClick={() => void download()}>下载视频</Button>
      </Callout>
    );
  }
  return <video className="video-player" src={state.url} controls autoPlay preload="metadata" onError={() => setBroken(true)} />;
}
