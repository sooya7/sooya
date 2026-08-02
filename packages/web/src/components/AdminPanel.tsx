import { FormEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../lib/api.js';
import { useAutoNotice } from '../lib/autoNotice.js';
import { AvatarEditor, LifePanel, StorageEditor, VoiceEditor } from './FeatureAdminPage.js';
import {
  interfaceOptions,
  MODEL_SLOTS,
  presetsBySlot,
  removePreset,
  SLOT_LABELS,
  SLOT_PROVIDERS,
  suggestId,
  presetFromConfig,
  upsertPreset,
  validatePreset,
  type ModelPreset,
  type ModelSlot
} from '../lib/modelPresets.js';
import {
  adminApi,
  clearAdminToken,
  getAdminToken,
  setAdminToken,
  type AdminBackup,
  type AdminCapabilities,
  type AdminError,
  type AdminJob,
  type AdminMedia,
  type AdminMemory,
  type AdminRecallTrace,
  type AdminModels,
  type AdminPersona,
  type AdminSticker,
  type AdminSystemStatus
} from '../lib/admin.js';

export type Tab =
  | 'overview'
  | 'persona'
  | 'avatar'
  | 'voice'
  | 'life'
  | 'models'
  | 'content'
  | 'storage'
  | 'operations';
type Dashboard = { system: AdminSystemStatus; capabilities: AdminCapabilities; backups: AdminBackup[] };
type IconName = 'overview' | 'persona' | 'models' | 'content' | 'operations' | 'message' | 'cpu' | 'storage' | 'backup' | 'lock';

const CAPABILITIES = [
  ['chat', '聊天模型'],
  ['vision', '视觉理解模型'],
  ['summary', '对话总结模型'],
  ['embedding', '向量模型'],
  ['image', '图片生成模型'],
  ['tts', '语音合成模型']
] as const;

/** Nav groups, so nine sections read as a structure instead of a list. */
const NAV_GROUPS = ['运行状态', '助手与表达', '内容与系统'] as const;
type NavGroup = (typeof NAV_GROUPS)[number];

const TABS: ReadonlyArray<{ id: Tab; label: string; description: string; icon: IconName; group: NavGroup }> = [
  { group: '运行状态', id: 'overview', label: '概览', description: '运行状态与资源', icon: 'overview' },
  { group: '助手与表达', id: 'persona', label: '助手配置', description: '人设与表达方式', icon: 'persona' },
  { group: '内容与系统', id: 'models', label: '模型配置', description: '接口与能力模型', icon: 'models' },
  { group: '助手与表达', id: 'avatar', label: '双方头像', description: '助手与用户头像', icon: 'persona' },
  { group: '助手与表达', id: 'voice', label: '情绪语音', description: '语气与语音合成', icon: 'message' },
  { group: '助手与表达', id: 'life', label: '她的生活', description: '此刻在做什么与主动开口', icon: 'message' },
  { group: '内容与系统', id: 'content', label: '内容管理', description: '记忆、媒体和表情', icon: 'content' },
  { group: '内容与系统', id: 'storage', label: '存储治理', description: '清理与空间回收', icon: 'storage' },
  { group: '内容与系统', id: 'operations', label: '运维与备份', description: '任务、错误和备份', icon: 'operations' }
];

export function adminPathForTab(tab: Tab): string {
  return `/admin/${tab}`;
}

export function tabFromAdminPath(pathname: string, fallback: Tab = 'overview'): Tab {
  const normalized = pathname.replace(/\/+$/, '') || '/admin';
  if (normalized === '/admin/features') return 'avatar';
  const segment = normalized.split('/')[2] as Tab | undefined;
  return segment && TABS.some((item) => item.id === segment) ? segment : fallback;
}

const PAGE_COPY: Record<Tab, { title: string; description: string }> = {
  overview: { title: '系统概览', description: '查看 SOOYA 当前运行状态和资源使用情况。' },
  persona: { title: '助手配置', description: '调整助手身份、语气和关系设定。' },
  models: { title: '模型配置', description: '管理每项能力对应的接口与模型。' },
  avatar: { title: '双方头像', description: '上传助手与用户头像，聊天页面即时生效。' },
  voice: { title: '情绪语音', description: '配置语音合成的情绪、语速与表达方式。' },
  life: { title: '她的生活', description: '她此刻在做什么、今天做过什么，以及她为什么还没主动开口。' },
  content: { title: '内容管理', description: '管理长期记忆、表情包、媒体和聊天记录。' },
  storage: { title: '存储治理', description: '预览并执行媒体清理，回收磁盘空间。' },
  operations: { title: '运维与备份', description: '检查错误与后台任务，并管理数据备份。' }
};

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, JSX.Element> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    persona: <><circle cx="12" cy="8" r="4" /><path d="M4.8 21a7.2 7.2 0 0 1 14.4 0" /></>,
    models: <><rect x="4" y="4" width="16" height="16" rx="4" /><path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" /></>,
    content: <><path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" /><path d="m7 15 3-3 2.5 2.5L15 12l3 3M8 9h.01" /></>,
    operations: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" /></>,
    message: <><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-1-1.73V7a2 2 0 0 1 2-2Z" /><path d="M8 9h8M8 13h5" /></>,
    cpu: <><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></>,
    storage: <><ellipse cx="12" cy="5.5" rx="8" ry="3.5" /><path d="M4 5.5v6c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-6M4 11.5v6c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5v-6" /></>,
    backup: <><path d="M7 7h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4v-6a4 4 0 0 1 4-4Z" /><path d="M8 7V4h8v3M9 14h6M12 11v6" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function formatBytes(value: unknown): string {
  const n = typeof value === 'number' ? value : 0;
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

function capabilityCounts(c: Record<string, unknown>) {
  const all = Object.values(c);
  const available = all.filter(
    (v) => !!v && typeof v === 'object' && ((v as { ok?: boolean }).ok || (v as { configured?: boolean }).configured)
  ).length;
  return { available, total: all.length };
}

function confirmAction(message: string) {
  return window.confirm(message);
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setIsMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return isMobile;
}

function SectionNotice({ notice }: { notice: string | null }) {
  return notice ? <div className="admin-inline-error" role="status">{notice}</div> : null;
}

function PanelHeading({ title, description }: { title: string; description: string }) {
  return <div className="admin-panel-heading"><div><h2>{title}</h2><p>{description}</p></div></div>;
}

function EmptyState({ children }: { children: string }) {
  return <div className="admin-empty">{children}</div>;
}

function PersonaPanel({ onNotice }: { onNotice: (v: string) => void }) {
  const [persona, setPersona] = useState<AdminPersona | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void adminApi.persona()
      .then((r) => setPersona(r.persona))
      .catch((e) => onNotice(errorText(e)))
      .finally(() => setLoading(false));
  }, [onNotice]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!persona) return;
    try {
      const r = await adminApi.updatePersona({
        name: persona.name,
        tagline: persona.tagline,
        systemPrompt: persona.systemPrompt,
        speakingStyle: persona.speakingStyle,
        relationshipContext: persona.relationshipContext,
        language: persona.language
      });
      setPersona(r.persona);
      onNotice('人设已保存');
    } catch (err) {
      onNotice(errorText(err));
    }
  };

  if (loading) return <p className="admin-muted">正在读取人设…</p>;
  if (!persona) return null;

  return (
    <form className="admin-form-card" data-testid="admin-persona-form" onSubmit={save}>
      <PanelHeading title="助手人设" description="这些内容会直接影响助手的身份、语气和回复方式。" />
      <label>名称<input value={persona.name} onChange={(e) => setPersona({ ...persona, name: e.target.value })} /></label>
      <label>状态文字<input value={persona.tagline} onChange={(e) => setPersona({ ...persona, tagline: e.target.value })} /></label>
      <label className="admin-form-wide">系统提示词<textarea value={persona.systemPrompt} onChange={(e) => setPersona({ ...persona, systemPrompt: e.target.value })} /></label>
      <label>说话风格<textarea value={persona.speakingStyle} onChange={(e) => setPersona({ ...persona, speakingStyle: e.target.value })} /></label>
      <label>关系设定<textarea value={persona.relationshipContext} onChange={(e) => setPersona({ ...persona, relationshipContext: e.target.value })} /></label>
      <label>语言<input value={persona.language} onChange={(e) => setPersona({ ...persona, language: e.target.value })} /></label>
      <div className="admin-actions"><button type="submit">保存人设</button></div>
    </form>
  );
}

/**
 * The saved model library. The seven capability slots are fixed, so this is the
 * only place an operator can add a model rather than overwrite one; applying a
 * preset is what actually assigns it to its slot on the server.
 */
function ModelLibrary({ onNotice, onApplied, reloadKey = 0 }: { onNotice: (v: string) => void; onApplied: (models: AdminModels) => void; reloadKey?: number }) {
  const [presets, setPresets] = useState<ModelPreset[] | null>(null);
  const [draft, setDraft] = useState<ModelPreset | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // reloadKey changes when the config form adds an entry, so this list never
  // keeps a stale copy it would later write back over the new one.
  useEffect(() => {
    void adminApi.modelPresets().then((r) => setPresets(r.presets)).catch((e) => onNotice(errorText(e)));
  }, [onNotice, reloadKey]);

  const commit = async (next: ModelPreset[], message: string) => {
    setBusy(true);
    try {
      const saved = await adminApi.saveModelPresets(next);
      setPresets(saved.presets);
      setDraft(null);
      setEditingId(null);
      onNotice(message);
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!draft || !presets) return;
    const problem = validatePreset(draft, presets, editingId);
    if (problem) {
      onNotice(problem);
      return;
    }
    void commit(upsertPreset(presets, draft, editingId), editingId ? '预设已更新' : '预设已添加');
  };

  const apply = async (preset: ModelPreset) => {
    setBusy(true);
    try {
      const result = await adminApi.applyModelPreset(preset.id);
      onApplied(result.models);
      onNotice(`已把「${preset.name}」指派给${SLOT_LABELS[preset.slot]}`);
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const update = (patch: Partial<ModelPreset>) => setDraft((prev) => {
    if (!prev) return prev;
    const next = { ...prev, ...patch };
    // A slot change can strand the provider on something that slot rejects.
    if (patch.slot && !SLOT_PROVIDERS[patch.slot].includes(next.provider)) {
      next.provider = SLOT_PROVIDERS[patch.slot][0] ?? '';
    }
    return next;
  });

  if (!presets) return <p className="admin-muted">正在读取模型库…</p>;
  const groups = presetsBySlot(presets);

  return (
    <section className="admin-model-library" data-testid="admin-model-library">
      <PanelHeading title="模型库" description="保存任意多个模型预设，随时指派给某项能力。预设只记录密钥的环境变量名，不保存密钥本身。" />
      {groups.length === 0 && <p className="admin-muted">还没有预设。把下面的配置填好后点「添加配置」，就能在不同模型之间随时切换。</p>}
      {groups.map(([slot, items]) => (
        <div className="admin-preset-group" key={slot}>
          <h3>{SLOT_LABELS[slot]}</h3>
          {items.map((preset) => (
            <div className={editingId === preset.id ? 'admin-preset-row active' : 'admin-preset-row'} key={preset.id} data-testid={`admin-preset-${preset.id}`}>
              <div className="admin-preset-copy">
                <strong>{preset.name}</strong>
                <small>{preset.model} · {preset.provider}{preset.baseUrl ? ` · ${preset.baseUrl}` : ''}{preset.apiKeyEnv ? ` · 密钥取自 ${preset.apiKeyEnv}` : ''}</small>
                {preset.notes && <small>{preset.notes}</small>}
              </div>
              <div className="admin-preset-actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void apply(preset)}>指派</button>
                <button type="button" disabled={busy} onClick={() => { setDraft(preset); setEditingId(preset.id); }}>编辑</button>
                <button type="button" className="danger" disabled={busy} onClick={() => void commit(removePreset(presets, preset.id), '预设已删除')}>删除</button>
              </div>
            </div>
          ))}
        </div>
      ))}

      {draft ? (
        <div className="admin-preset-form" data-testid="admin-preset-form">
          <label>预设名称<input value={draft.name} onChange={(e) => {
            const name = e.target.value;
            update(editingId ? { name } : { name, id: draft.id || suggestId(name) });
          }} /></label>
          <label>预设 ID<input value={draft.id} disabled={Boolean(editingId)} onChange={(e) => update({ id: e.target.value })} /></label>
          <label>指派能力<select value={draft.slot} onChange={(e) => update({ slot: e.target.value as ModelSlot })}>
            {MODEL_SLOTS.map((slot) => <option key={slot} value={slot}>{SLOT_LABELS[slot]}</option>)}
          </select></label>
          <label>接口协议<select value={draft.provider} onChange={(e) => update({ provider: e.target.value })}>
            {SLOT_PROVIDERS[draft.slot].map((provider) => <option key={provider} value={provider}>{provider}</option>)}
          </select></label>
          <label>模型名<input value={draft.model} onChange={(e) => update({ model: e.target.value })} /></label>
          <label>接口地址<input value={draft.baseUrl} placeholder="留空则用默认地址" onChange={(e) => update({ baseUrl: e.target.value })} /></label>
          <label>密钥环境变量<input value={draft.apiKeyEnv} placeholder="例如 GLM_API_KEY" onChange={(e) => update({ apiKeyEnv: e.target.value })} /></label>
          <label>备注<input value={draft.notes} onChange={(e) => update({ notes: e…5422 tokens truncated…0027)) void adminApi.deleteMedia(m.id).then(load).catch((e) => onNotice(errorText(e))); }}>删除</button></div>) : <EmptyState>暂无媒体文件</EmptyState>}
      </article>

      <article className="admin-card">
        <h2>聊天记录</h2>
        <p>永久会话仅支持整体清空，避免误删单条上下文造成记忆断裂。</p>
        <div className="admin-actions"><button type="button" className="admin-danger" onClick={() => { if (confirmAction('确认清空全部聊天记录？此操作不可撤销。')) void adminApi.clearChat().then(() => onNotice('聊天记录已清空')).catch((e) => onNotice(errorText(e))); }}>清空聊天记录</button></div>
      </article>
    </section>
  );
}

function StickerUpload({ onDone, onNotice }: { onDone: () => Promise<void>; onNotice: (s: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const upload = async () => {
    if (!file) return;
    const form = new FormData();
    form.append('name', file.name.replace(/\.[^.]+$/, ''));
    form.append('emotion', 'neutral');
    form.append('tags', 'neutral');
    form.append('file', file);
    try {
      await adminApi.uploadSticker(form);
      setFile(null);
      await onDone();
      onNotice('表情包已上传');
    } catch (e) {
      onNotice(errorText(e));
    }
  };
  return <div className="admin-upload"><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /><button type="button" disabled={!file} onClick={() => void upload()}>上传表情包</button></div>;
}

function OperationsPanel({ onNotice }: { onNotice: (v: string) => void }) {
  const [errors, setErrors] = useState<AdminError[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [backups, setBackups] = useState<AdminBackup[]>([]);

  const load = useCallback(async () => {
    try {
      const [e, j, b] = await Promise.all([adminApi.errors(), adminApi.jobs(), adminApi.backups()]);
      setErrors(e.errors);
      setJobs(j.jobs);
      setBackups(b.backups);
    } catch (err) {
      onNotice(errorText(err));
    }
  }, [onNotice]);

  useEffect(() => { void load(); }, [load]);

  const run = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work();
      await load();
      onNotice(message);
    } catch (e) {
      onNotice(errorText(e));
    }
  };

  return (
    <section className="admin-operations">
      <article className="admin-card" data-testid="admin-error-list">
        <div className="admin-card-subtitle"><h2>最近错误</h2><span className="admin-count-badge">{errors.length}</span></div>
        {errors.length ? errors.map((e) => <div className="admin-list-row" key={e.id}><span>{e.scope} · {e.message}</span><small>{new Date(e.createdAt).toLocaleString()}</small></div>) : <EmptyState>暂无错误记录</EmptyState>}
        <div className="admin-actions"><button type="button" className="admin-danger" onClick={() => { if (confirmAction('确认清空错误记录？')) void run(() => adminApi.clearErrors(), '错误记录已清空'); }}>清空错误记录</button></div>
      </article>

      <article className="admin-card" data-testid="admin-job-list">
        <div className="admin-card-subtitle"><h2>后台任务</h2><span className="admin-count-badge">{jobs.length}</span></div>
        {jobs.length ? jobs.map((j) => <div className="admin-list-row" key={j.id}><span>{j.type} · {j.status}</span><small>{j.attempts}/{j.max_attempts}</small></div>) : <EmptyState>暂无后台任务</EmptyState>}
      </article>

      <article className="admin-card" data-testid="admin-backup-list">
        <div className="admin-card-heading"><div><h2>备份</h2><p>{backups.length} 份可用备份</p></div><button type="button" onClick={() => void run(() => adminApi.createBackup(), '备份已创建')}>创建备份</button></div>
        {backups.length ? backups.map((b) => <div className="admin-list-row" key={b.name}><span>{b.name} · {formatBytes(b.bytes)}</span><div><button type="button" onClick={() => void run(() => adminApi.verifyBackup(b.name), '备份校验完成')}>校验</button><button type="button" onClick={() => { if (confirmAction(`确认恢复备份“${b.name}”？`)) void run(() => adminApi.restoreBackup(b.name), '备份已恢复，请刷新聊天页面'); }}>恢复</button><button type="button" className="admin-danger" onClick={() => { if (confirmAction(`确认删除备份“${b.name}”？`)) void run(() => adminApi.deleteBackup(b.name), '备份已删除'); }}>删除</button></div></div>) : <EmptyState>暂无备份，可先创建一份</EmptyState>}
      </article>
    </section>
  );
}

/** Loads the persona the avatar editor edits, which the old page shell owned. */
function AvatarPanel({ onNotice }: { onNotice: (v: string) => void }) {
  const [persona, setPersona] = useState<AdminPersona | null>(null);
  useEffect(() => {
    void adminApi.persona().then((r) => setPersona(r.persona)).catch((e) => onNotice(errorText(e)));
  }, [onNotice]);
  if (!persona) return <p className="admin-muted">正在读取头像设置…</p>;
  return <AvatarEditor persona={persona} onPersona={setPersona} onNotice={onNotice} />;
}

function TabButtons({ tab, setTab, mobile }: { tab: Tab; setTab: (tab: Tab) => void; mobile: boolean }) {
  return (
    <nav className={mobile ? 'admin-mobile-tabs' : 'admin-side-nav'} aria-label="管理面板导航">
      {mobile
        ? TABS.map((item) => (
          <button key={item.id} type="button" data-testid={`admin-tab-${item.id}`} aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))
        : NAV_GROUPS.map((group) => (
          <Fragment key={group}>
            <p className="admin-nav-group">{group}</p>
            {TABS.filter((item) => item.group === group).map((item) => (
              <button key={item.id} type="button" data-testid={`admin-tab-${item.id}`} aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
                <span className="admin-nav-icon"><Icon name={item.icon} /></span>
                <span className="admin-nav-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
              </button>
            ))}
          </Fragment>
        ))}
    </nav>
  );
}

function Overview({ data, counts, onRefresh }: { data: Dashboard; counts: { available: number; total: number }; onRefresh: () => void }) {
  const db = data.system.database;
  const storage = data.system.storage;
  const tiles = [
    { label: '消息与记忆', value: `${Number(db.messages ?? 0).toLocaleString()} 条消息`, detail: `${Number(db.memories ?? 0).toLocaleString()} 条记忆`, icon: 'message' as const },
    { label: '模型能力', value: `${counts.available} / ${counts.total} 可用`, detail: '按服务端实际能力统计', icon: 'cpu' as const },
    { label: '存储占用', value: formatBytes(storage.mediaBytes), detail: `${Number(db.media ?? 0).toLocaleString()} 个媒体文件`, icon: 'storage' as const },
    { label: '备份', value: `${data.backups.length} 份`, detail: `待处理任务 ${Number(db.pendingJobs ?? 0)}`, icon: 'backup' as const }
  ];

  return <>
    <section className="admin-status-card" data-testid="admin-system-status">
      <div><span className="admin-health-dot" /><strong>运行正常</strong></div>
      <span>版本 {data.system.version}</span>
      <span>已运行 {formatUptime(data.system.uptimeSec)}</span>
      <button type="button" onClick={onRefresh}>刷新状态</button>
    </section>
    <section className="admin-summary">
      {tiles.map((tile) => <div className="admin-summary-tile" key={tile.label}><div className="admin-summary-top"><span>{tile.label}</span><span className="admin-summary-icon"><Icon name={tile.icon} /></span></div><strong>{tile.value}</strong><small>{tile.detail}</small></div>)}
    </section>
  </>;
}

export default function AdminPanel({ initialTab = 'overview' }: { initialTab?: Tab } = {}) {
  const [token, setToken] = useState(() => getAdminToken());
  const [tokenInput, setTokenInput] = useState('');
  const [tab, setTab] = useState<Tab>(() => tabFromAdminPath(window.location.pathname, initialTab));
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [data, setData] = useState<Dashboard | null>(null);
  const [notice, setNotice] = useAutoNotice();
  const [loading, setLoading] = useState(false);
  const isMobile = useIsMobile();

  const setDirtyState = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);

  useEffect(() => {
    const routeTab = tabFromAdminPath(window.location.pathname, initialTab);
    const canonicalPath = adminPathForTab(routeTab);
    if (window.location.pathname !== canonicalPath) {
      window.history.replaceState(null, '', canonicalPath);
    }

    const onPopState = () => {
      const next = tabFromAdminPath(window.location.pathname, initialTab);
      if (dirtyRef.current && !window.confirm('当前修改尚未保存，确定离开吗？')) {
        window.history.pushState(null, '', adminPathForTab(tab));
        return;
      }
      setDirtyState(false);
      setTab(next);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [initialTab, setDirtyState, tab]);

  const navigateTab = useCallback((next: Tab) => {
    if (next === tab) return;
    if (dirtyRef.current && !window.confirm('当前修改尚未保存，确定离开吗？')) return;
    setDirtyState(false);
    window.history.pushState(null, '', adminPathForTab(next));
    setTab(next);
  }, [setDirtyState, tab]);

  const loadOverview = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [system, capabilities, backups] = await Promise.all([
        adminApi.system(),
        adminApi.capabilities(),
        adminApi.backups()
      ]);
      setData({ system, capabilities, backups: backups.backups });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearAdminToken();
        setToken(null);
        setData(null);
      } else {
        setNotice(errorText(e));
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void loadOverview(); }, [loadOverview]);

  const submitToken = (e: FormEvent) => {
    e.preventDefault();
    const next = tokenInput.trim();
    if (!next) return;
    setAdminToken(next);
    setToken(next);
    setTokenInput('');
  };

  const logout = () => {
    clearAdminToken();
    setToken(null);
    setData(null);
    setNotice(null);
  };

  const counts = useMemo(
    () => data ? capabilityCounts(data.capabilities.capabilities) : { available: 0, total: 0 },
    [data]
  );

  if (!token) {
    return <main className="admin-page admin-v2 admin-lock-page" data-testid="admin-lock"><form className="admin-lock-card" onSubmit={submitToken}><span className="admin-lock-icon"><Icon name="lock" /></span><span className="admin-eyebrow">SOOYA 管理中心</span><h1>输入管理令牌</h1><p>令牌只保存在当前设备，用于访问管理接口。</p><label htmlFor="admin-token">管理令牌</label><input id="admin-token" type="password" autoComplete="current-password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} /><button type="submit" disabled={!tokenInput.trim()}>进入管理中心</button></form></main>;
  }

  if (loading && !data) {
    return <main className="admin-page admin-v2 admin-loading"><div className="admin-loading-card"><div className="admin-spinner" />正在读取系统状态…</div></main>;
  }

  if (!data) {
    return <main className="admin-page admin-v2 admin-error"><div className="admin-error-card"><p>{notice ?? '无法加载管理信息'}</p><button type="button" onClick={() => void loadOverview()}>重试</button></div></main>;
  }

  const page = PAGE_COPY[tab];
  const content = tab === 'overview'
    ? <Overview data={data} counts={counts} onRefresh={() => void loadOverview()} />
    : tab === 'persona'
      ? <PersonaPanel onNotice={setNotice} />
      : tab === 'avatar'
        ? <AvatarPanel onNotice={setNotice} />
        : tab === 'voice'
          ? <VoiceEditor onNotice={setNotice} />
          : tab === 'life'
            ? <LifePanel onNotice={setNotice} />
            : tab === 'models'
                ? <ModelsPanel onNotice={setNotice} />
                : tab === 'content'
                  ? <ContentPanel onNotice={setNotice} />
                  : tab === 'storage'
                    ? <StorageEditor onNotice={setNotice} />
                    : <OperationsPanel onNotice={setNotice} />;

  return (
    <main className="admin-page admin-v2" data-testid="admin-dashboard" data-dirty={dirty || undefined} onInputCapture={(event) => {
      const target = event.target as HTMLInputElement;
      if (target instanceof HTMLInputElement && target.type === 'file') return;
      setDirtyState(true);
    }} onSubmitCapture={() => setDirtyState(false)}>
      <div className="admin-shell">
        {!isMobile && <aside className="admin-sidebar">
          <div className="admin-brand"><span className="admin-brand-mark">S</span><span className="admin-brand-copy"><strong>SOOYA</strong><small>管理中心</small></span></div>
          <TabButtons tab={tab} setTab={navigateTab} mobile={false} />
          <div className="admin-sidebar-footer">
            <a className="admin-side-action" href="/" data-testid="admin-return-chat">返回对话</a>
            <button type="button" className="admin-side-action subtle" onClick={logout}>退出管理</button>
          </div>
        </aside>}

        {isMobile && <header className="admin-mobile-header"><div className="admin-mobile-brand"><span className="admin-mobile-icon"><Icon name={TABS.find((item) => item.id === tab)?.icon ?? 'overview'} /></span><div><strong>SOOYA 管理中心</strong><small>{page.title}</small></div></div><a className="admin-return" href="/" data-testid="admin-return-chat">返回对话</a></header>}

        <section className="admin-main">
          <div className="admin-main-inner">
            {isMobile && <TabButtons tab={tab} setTab={navigateTab} mobile />}
            {!isMobile && <header className="admin-content-header"><div className="admin-title-wrap"><span className="admin-eyebrow">SOOYA ADMIN</span><h1>{page.title}</h1><p>{page.description}</p></div><div className="admin-header-actions"><button type="button" className="admin-header-button" onClick={() => void loadOverview()}>刷新</button></div></header>}
            <div className="admin-mobile-content">
              {isMobile && <div className="admin-mobile-title"><h1>{page.title}</h1><p>{page.description}</p></div>}
              <SectionNotice notice={notice} />
              {content}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
