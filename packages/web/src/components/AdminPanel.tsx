import { FormEvent, Fragment, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MetricsSummary } from './MetricsSummary.js';
import { ApiError } from '../lib/api.js';
import { useAutoNotice } from '../lib/autoNotice.js';
import { navigate, APP_NAVIGATION_EVENT } from '../lib/navigation.js';
import { AppLink } from './AppLink.js';
import { formatAdminDateTime } from '../lib/adminDisplay.js';
import { featureApi } from '../lib/features.js';
import { AvatarEditor, emotionLabel, ReferencesEditor, StorageEditor } from './FeatureAdminPage.js';
import { LifeObservationPanel } from './life/LifeObservationPanel.js';
import { WebSearchModelEditor } from './WebSearchModelEditor.js';
import { McpAdminPage } from './admin/McpAdminPage.js';
import { ContentManagementPage } from './admin/ContentManagementPage.js';
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
  ADMIN_UNAUTHORIZED_EVENT,
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
  type AdminSystemStatus,
  type AdminWebSearchConfig
} from '../lib/admin.js';

export type Tab =
  | 'overview'
  | 'persona'
  | 'avatar'
  | 'life'
  | 'models'
  | 'mcp'
  | 'content'
  | 'storage'
  | 'operations';
type Dashboard = { system: AdminSystemStatus; capabilities: AdminCapabilities; backups: AdminBackup[] };
type IconName = 'overview' | 'persona' | 'models' | 'mcp' | 'content' | 'operations' | 'message' | 'cpu' | 'storage' | 'backup' | 'lock';

const CAPABILITIES = [
  ['chat', '聊天模型'],
  ['vision', '视觉理解模型'],
  ['summary', '对话总结模型'],
  ['director', '媒体导演模型'],
  ['embedding', '向量模型'],
  ['rerank', '记忆重排模型'],
  ['image', '图片生成模型'],
  ['tts', '语音合成模型'],
  ['webSearch', '联网搜索']
] as const;
const CAPABILITY_DESCRIPTIONS: Partial<Record<ModelPanelSelection, string>> = {
  director: '媒体导演统一负责表情选择、语音口语化和图片提示词扩写；未单独配置时回退聊天模型。它处理短结构化文本，不负责读图。'
};
type ModelPanelSelection = ModelSlot | 'webSearch';

/** Nav groups, so nine sections read as a structure instead of a list. */
const NAV_GROUPS = ['运行状态', '助手与表达', '内容与系统'] as const;
type NavGroup = (typeof NAV_GROUPS)[number];

const TABS: ReadonlyArray<{ id: Tab; label: string; description: string; icon: IconName; group: NavGroup }> = [
  { group: '运行状态', id: 'overview', label: '概览', description: '运行状态与资源', icon: 'overview' },
  { group: '助手与表达', id: 'persona', label: '助手配置', description: '人设与表达方式', icon: 'persona' },
  { group: '内容与系统', id: 'models', label: '模型配置', description: '接口与能力模型', icon: 'models' },
  { group: '助手与表达', id: 'avatar', label: '双方头像', description: '助手与用户头像', icon: 'persona' },
  { group: '助手与表达', id: 'life', label: '她的生活', description: '此刻在做什么与主动开口', icon: 'message' },
  { group: '内容与系统', id: 'content', label: '内容管理', description: '记忆、媒体和表情', icon: 'content' },
  { group: '内容与系统', id: 'mcp', label: 'MCP 服务', description: '连接、工具与策略观测', icon: 'mcp' },
  { group: '内容与系统', id: 'storage', label: '存储治理', description: '清理与空间回收', icon: 'storage' },
  { group: '内容与系统', id: 'operations', label: '运维与备份', description: '任务、错误和备份', icon: 'operations' }
];

export function adminPathForTab(tab: Tab): string {
  return tab === 'content' ? '/admin/content/memory' : `/admin/${tab}`;
}

export function tabFromAdminPath(pathname: string, fallback: Tab = 'overview'): Tab {
  const normalized = pathname.replace(/\/+$/, '') || '/admin';
  if (normalized === '/admin/features') return 'avatar';
  const segment = normalized.split('/')[2] as Tab | undefined;
  return segment && TABS.some((item) => item.id === segment) ? segment : fallback;
}

function isContentSubroute(pathname: string): boolean {
  return /^\/admin\/content\/(memory|stickers|media|chat)\/?$/u.test(pathname.replace(/\/+$/, ''));
}

const PAGE_COPY: Record<Tab, { title: string; description: string }> = {
  mcp: { title: 'MCP 服务', description: '观察外部 MCP 连接和安全工具元数据。' },
  overview: { title: '系统概览', description: '查看 SOOYA 当前运行状态和资源使用情况。' },
  persona: { title: '助手配置', description: '调整助手身份、语气和说话方式。' },
  models: { title: '模型配置', description: '管理每项能力对应的接口与模型。' },
  avatar: { title: '双方头像', description: '上传助手与用户头像，聊天页面即时生效。' },
  life: { title: '她的生活', description: '她此刻在做什么、今天做过什么，以及她为什么还没主动开口。' },
  content: { title: '内容管理', description: '管理长期记忆、表情包、媒体和聊天记录。' },
  storage: { title: '存储治理', description: '预览并执行媒体清理，回收磁盘空间。' },
  operations: { title: '运维与备份', description: '检查错误与后台任务，并管理数据备份。' }
};

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, JSX.Element> = {
    mcp: <><circle cx="7" cy="12" r="3" /><circle cx="17" cy="7" r="3" /><circle cx="17" cy="17" r="3" /><path d="m9.5 10.5 5-2M9.5 13.5l5 2" /></>,
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

const RECALL_STRATEGY_LABELS: Record<string, string> = {
  none: '未召回',
  embedding: '语义向量',
  fts: '关键词检索'
};
const RECALL_FALLBACK_LABELS: Record<string, string> = {
  'no memories stored': '尚未存储记忆',
  'memory disabled': '记忆功能未启用',
  'embedding provider not configured': '未配置向量模型',
  'no memories carry embeddings of the current dimension': '现有记忆没有可用的同维度向量'
};
const MEMORY_KIND_LABELS: Record<string, string> = {
  fact: '事实', preference: '偏好', event: '事件', relationship: '关系', summary: '摘要'
};
const MEDIA_KIND_LABELS: Record<string, string> = {
  image: '图片', sticker: '表情包', audio: '语音', file: '文件'
};
const RECALL_DROP_LABELS: Record<string, string> = {
  deduplicated_persona: '与人设重复',
  deduplicated_summary: '与阶段摘要重复',
  deduplicated_recent: '与近期对话重复',
  budget: '超出上下文预算'
};

function recallStrategyLabel(value: string): string {
  return RECALL_STRATEGY_LABELS[value] ?? value;
}

function recallFallbackLabel(value: string): string {
  if (RECALL_FALLBACK_LABELS[value]) return RECALL_FALLBACK_LABELS[value]!;
  if (value.startsWith('embedding dimension mismatch')) return '向量维度不匹配';
  if (value.startsWith('embedding provider failed')) return '向量服务调用失败';
  return value;
}

function recallDropLabel(value: string | undefined): string {
  if (!value) return '未知';
  return RECALL_DROP_LABELS[value] ?? value;
}

function recallMatchReasonLabel(value: string): string {
  if (value === 'FTS lexical match') return '关键词匹配';
  const embedding = value.match(/^embedding cosine ([\d.]+)(, reranked)?$/);
  if (embedding) return `语义相似度 ${embedding[1]}${embedding[2] ? '，经重排' : ''}`;
  return value;
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
      <label>语言<input value={persona.language} onChange={(e) => setPersona({ ...persona, language: e.target.value })} /></label>
      <div className="admin-actions"><button type="submit">保存人设</button></div>
    </form>
  );
}

/**
 * Voice-system convergence §4.1: the only two voice behavior knobs left in
 * the panel — whether she ever sends voice, and the per-clip length cap.
 * Provider parameters and per-mood mappings live in 「模型配置 → 语音合成」.
 */
function VoiceBehaviorEditor({ onNotice }: { onNotice: (v: string) => void }) {
  const [behavior, setBehavior] = useState<{ enabled: boolean; maxVoiceSeconds: number } | null>(null);

  useEffect(() => {
    void adminApi.voiceBehavior().then(setBehavior).catch((e) => onNotice(errorText(e)));
  }, [onNotice]);

  if (!behavior) return <p className="admin-muted">正在读取语音行为…</p>;
  const save = async () => {
    try {
      setBehavior(await adminApi.updateVoiceBehavior({ enabled: behavior.enabled, maxVoiceSeconds: behavior.maxVoiceSeconds }));
      onNotice('语音行为已保存');
    } catch (e) {
      onNotice(errorText(e));
    }
  };
  return (
    <section className="admin-form-card" data-testid="voice-behavior-settings">
      <div className="admin-panel-heading"><div><h2>语音行为</h2><p>她什么时候发语音由模型判断与你的使用偏好共同决定；这里只保留最基础的两个开关。音色、接口和语速在「模型配置 → 语音合成」里设置。</p></div></div>
      <label><span>启用语音</span><input type="checkbox" checked={behavior.enabled} onChange={(e) => setBehavior({ ...behavior, enabled: e.target.checked })} /></label>
      <label>单条语音最大长度（秒）<input type="number" min={5} max={120} value={behavior.maxVoiceSeconds} onChange={(e) => setBehavior({ ...behavior, maxVoiceSeconds: Number(e.target.value) })} /></label>
      <div className="admin-actions"><button type="button" onClick={() => void save()}>保存语音行为</button></div>
    </section>
  );
}

/**
 * The saved model library. The eight capability slots are fixed, so this is the
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
      <PanelHeading title="模型库" description="保存模型及其服务器端密钥绑定，指派时一起切换；密钥不会返回浏览器。旧预设仍沿用该能力当前的密钥。" />
      {groups.length === 0 && <p className="admin-muted">还没有预设。把下面的配置填好后点「存入模型库」，就能在不同模型之间随时切换。</p>}
      {groups.map(([slot, items]) => (
        <div className="admin-preset-group" key={slot}>
          <h3>{SLOT_LABELS[slot]}</h3>
          {items.map((preset) => (
            <div className={editingId === preset.id ? 'admin-preset-row active' : 'admin-preset-row'} key={preset.id} data-testid={`admin-preset-${preset.id}`}>
              <div className="admin-preset-copy">
                <strong>{preset.name}</strong>
                <small>{preset.model} · {preset.provider}{preset.baseUrl ? ` · ${preset.baseUrl}` : ''}</small>
                <small>{preset.apiKeyConfigured
                  ? '密钥已绑定'
                  : preset.apiKeyBound
                    ? '已绑定（无需密钥）'
                    : '未绑定密钥（旧预设）'}</small>
                {preset.notes && <small>{preset.notes}</small>}
              </div>
              <div className="admin-preset-actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void apply(preset)}>指派</button>
                <button type="button" disabled={busy} onClick={() => { setDraft(preset); setEditingId(preset.id); }}>编辑</button>
                <button type="button" className="admin-danger" disabled={busy} onClick={() => void commit(removePreset(presets, preset.id), '预设已删除')}>删除</button>
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
          <label>备注<input value={draft.notes} onChange={(e) => update({ notes: e.target.value })} /></label>
          <div className="admin-preset-form-actions">
            <button type="button" className="admin-primary" disabled={busy} onClick={submit}>{editingId ? '保存修改' : '添加到模型库'}</button>
            <button type="button" disabled={busy} onClick={() => { setDraft(null); setEditingId(null); }}>取消</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ModelsPanel({ onNotice }: { onNotice: (v: string) => void }) {
  const [models, setModels] = useState<AdminModels | null>(null);
  const [selected, setSelected] = useState<ModelPanelSelection>('chat');
  const [available, setAvailable] = useState<string[] | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [pulling, setPulling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [libraryKey, setLibraryKey] = useState(0);
  const [previewText, setPreviewText] = useState('你好呀，我刚刚想到你了。');
  const [previewEmotion, setPreviewEmotion] = useState('auto');
  const [previewing, setPreviewing] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    void adminApi.models().then((r) => setModels(r.models)).catch((e) => onNotice(errorText(e)));
  }, [onNotice]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const config = (models?.[selected] ?? {}) as Record<string, unknown>;
  const discoveryUnsupported = config.provider === 'anuma-input-images';
  const update = (key: string, value: unknown) => setModels((prev) => ({
    ...(prev ?? {}),
    [selected]: { ...config, [key]: value }
  }));

  const save = async () => {
    if (!models || selected === 'webSearch') return;
    try {
      const typed = keyDraft.trim();
      const r = await adminApi.updateModels({ [selected]: { ...config, ...(typed ? { apiKey: typed } : {}) } });
      setModels(r.models);
      setKeyDraft('');
      // The old verdict was about the config that was just replaced.
      setTestResult(null);
      onNotice(typed ? '模型配置与密钥已保存' : '模型配置已保存');
    } catch (e) {
      onNotice(errorText(e));
    }
  };

  /** 语音试听：走 /api/admin/voice/preview，Fish 与 OpenAI/Volc 同样可用。 */
  const previewVoice = async () => {
    setPreviewing(true);
    try {
      const blob = await featureApi.previewVoice(previewText.trim() || '你好呀，我刚刚想到你了。', previewEmotion === 'auto' ? 'neutral' : previewEmotion);
      const url = URL.createObjectURL(blob);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      if (previewAudioRef.current) {
        previewAudioRef.current.src = url;
        await previewAudioRef.current.play();
      }
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      setPreviewing(false);
    }
  };

  /** Asks the endpoint what it serves. The key stays server-side. */
  const pull = async () => {
    if (selected === 'webSearch') return;
    if (discoveryUnsupported) {
      onNotice('Anuma 不提供模型列表，请手动填写模型名');
      return;
    }
    if (keyDraft.trim()) {
      onNotice('请先点击“保存模型配置”，再拉取模型列表');
      return;
    }
    setPulling(true);
    try {
      const r = await adminApi.discoverModels(selected, String(config.baseUrl ?? '').trim() || undefined);
      setAvailable(r.models);
      onNotice(`拉取到 ${r.models.length} 个模型`);
    } catch (e) {
      setAvailable(null);
      onNotice(errorText(e));
    } finally {
      setPulling(false);
    }
  };

  /**
   * Probes the endpoint once with the *saved* config, so "saved" can be told
   * apart from "actually works". Unsaved form edits are not part of the probe.
   */
  const runTest = async () => {
    if (selected === 'webSearch') return;
    if (selected === 'image' && !confirmAction('测试出图会真实调用图片服务并消耗一次额度，确定继续吗？')) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await adminApi.testModel(selected, selected === 'image');
      const text = `连接正常：${r.provider}${r.model ? ` / ${r.model}` : ''}，${r.detail}，耗时 ${r.latencyMs} ms`;
      setTestResult({ ok: true, text });
      onNotice(text);
    } catch (e) {
      const text = errorText(e);
      setTestResult({ ok: false, text });
      onNotice(text);
    } finally {
      setTesting(false);
    }
  };

  /** Saves what is on screen into the library as a new entry. */
  const addToLibrary = async () => {
    if (selected === 'webSearch') return;
    if (keyDraft.trim()) {
      onNotice('请先点击“保存模型配置”，再存入模型库');
      return;
    }
    try {
      const current = await adminApi.modelPresets();
      const draft = presetFromConfig(selected, config, current.presets);
      if (typeof draft === 'string') {
        onNotice(draft);
        return;
      }
      await adminApi.addModelPreset(draft);
      setLibraryKey((k) => k + 1);
      onNotice(`已添加到模型库：${draft.name}`);
    } catch (e) {
      onNotice(errorText(e));
    }
  };

  if (!models) return <p className="admin-muted">正在读取模型配置…</p>;

  return (
    <section className="admin-model-layout" data-testid="admin-models-form">
      <aside>
        <h2>模型能力</h2>
        {CAPABILITIES.map(([key, label]) => (
          <button key={key} type="button" className={selected === key ? 'admin-model-item active' : 'admin-model-item'} onClick={() => { setSelected(key); setAvailable(null); setKeyDraft(''); setTestResult(null); }}>
            <span>{label}</span>
            <small>{key === 'webSearch'
              ? ((models.webSearch as AdminWebSearchConfig | undefined)?.enabled ? (models.webSearch as AdminWebSearchConfig).providers.join(' → ') : '已关闭')
              : String((models[key] as Record<string, unknown> | undefined)?.model ?? '未独立配置')}</small>
          </button>
        ))}
      </aside>
      <div className="admin-form-card">
        {selected === 'webSearch' ? <>
          <PanelHeading title="联网搜索" description="配置聊天需要外部实时信息时使用的搜索提供方。" />
          <WebSearchModelEditor
            config={models.webSearch as AdminWebSearchConfig}
            responsesAvailable={String((models.chat as Record<string, unknown> | undefined)?.provider ?? '') === 'openai-responses' && (models.chat as Record<string, unknown> | undefined)?.supportsTools === true}
            onSaved={setModels}
            onNotice={onNotice}
          />
        </> : <>
        <PanelHeading title={CAPABILITIES.find(([k]) => k === selected)?.[1] ?? '模型配置'} description={CAPABILITY_DESCRIPTIONS[selected] ?? '编辑当前能力使用的真实服务端配置。'} />
        <ModelLibrary onNotice={onNotice} onApplied={setModels} reloadKey={libraryKey} />
        <label>接口协议<select value={String(config.provider ?? 'none')} onChange={(e) => update('provider', e.target.value)}>
          {interfaceOptions(selected, config.provider == null ? null : String(config.provider)).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select></label>
        <label className="admin-form-wide">
          模型名
          <span className="admin-inline-field">
            <input list="admin-model-options" value={String(config.model ?? '')} onChange={(e) => update('model', e.target.value)} />
            <button type="button" data-testid="admin-model-pull" disabled={pulling || discoveryUnsupported} onClick={() => void pull()}>{pulling ? '拉取中…' : '拉取模型'}</button>
          </span>
          <datalist id="admin-model-options">
            {(available ?? []).map((name) => <option key={name} value={name} />)}
          </datalist>
          <small>
            {available
              ? `拉取到 ${available.length} 个模型，点输入框可选；列表可能不全，仍可手填。`
              : discoveryUnsupported
                ? 'Anuma 不提供模型列表接口，请直接填写供应商提供的模型名。'
                : '从接口地址拉取该服务提供的模型名。密钥不会离开服务器。'}
          </small>
        </label>
        <label className="admin-form-wide">
          接口地址
          <input
            value={String(config.baseUrl ?? '')}
            placeholder={selected === 'image' ? 'https://你的 NewAPI 地址/v1' : undefined}
            onChange={(e) => update('baseUrl', e.target.value)}
          />
          {selected === 'image' && (config.provider === 'openai-compatible' || config.provider === 'openai-images') && (
            <small>NewAPI 请填到 /v1 根路径，不要填 /images/generations；修改 API Key 后先保存，再拉取模型。</small>
          )}
        </label>
        {selected === 'image' && (config.provider === 'openai-compatible' || config.provider === 'openai-images') && (
          <label>
            New-Api-User（可选）
            <input value={String(config.newApiUserId ?? '')} onChange={(e) => update('newApiUserId', e.target.value)} placeholder="NewAPI 用户 ID" />
            <small>只有 NewAPI 的 /api/models 要求用户鉴权时填写；不知道就先留空。</small>
          </label>
        )}
        <label>
          API Key
          <input
            type="password"
            autoComplete="off"
            data-testid="admin-model-apikey"
            value={keyDraft}
            placeholder={config.apiKeyConfigured ? '已配置，留空则不改' : '粘贴密钥'}
            onChange={(e) => setKeyDraft(e.target.value)}
          />
          <small>{config.apiKeyConfigured ? '已保存一把密钥。要换就粘新的，留空则保持不变。' : '还没有密钥，粘贴后点保存。'}</small>
        </label>
        <label>请求超时（毫秒）<input type="number" value={String(config.timeoutMs ?? '')} onChange={(e) => update('timeoutMs', Number(e.target.value))} /></label>
        {['chat', 'vision', 'summary', 'director'].includes(selected) && <>
          <label>最大输出 Token<input type="number" value={String(config.maxTokens ?? '')} onChange={(e) => update('maxTokens', Number(e.target.value))} /></label>
          <label>Temperature<input type="number" step="0.1" value={String(config.temperature ?? '')} onChange={(e) => update('temperature', Number(e.target.value))} /></label>
          <label>上下文窗口<input type="number" value={String(config.contextWindow ?? '')} onChange={(e) => update('contextWindow', Number(e.target.value))} /></label>
          <label>最大重试次数<input type="number" value={String(config.maxRetries ?? '')} onChange={(e) => update('maxRetries', Number(e.target.value))} /></label>
        </>}
        {['chat', 'vision'].includes(selected) && (
          <label className="admin-form-wide">
            声明支持读图
            <select value={config.supportsVision ? 'yes' : 'no'} onChange={(e) => update('supportsVision', e.target.value === 'yes')}>
              <option value="no">否（发来的图片不会送给这个模型）</option>
              <option value="yes">是（模型真的能读图才选）</option>
            </select>
            <small>谎报为「是」会让带图的回复整条失败，而不是降级成纯文字。</small>
          </label>
        )}
        {selected === 'image' && <label>图片尺寸<input value={String(config.size ?? '')} onChange={(e) => update('size', e.target.value)} /></label>}
        {selected === 'image' && config.provider === 'anuma-input-images' && <>
          <p className="field-help">生成阶段不会自动重试，以免一次请求产生多张图片。</p>
          <label>Anuma 上传超时（毫秒）<input type="number" min="1000" max="120000" value={String(config.uploadTimeoutMs ?? 20000)} onChange={(e) => update('uploadTimeoutMs', Number(e.target.value))} /></label>
          <label>Anuma 上传重试次数<input type="number" min="0" max="3" value={String(config.uploadMaxRetries ?? 2)} onChange={(e) => update('uploadMaxRetries', Number(e.target.value))} /></label>
          <p className="admin-muted admin-form-wide">Anuma 图生图会先上传参考图，再把 HTTPS 地址传给 generations；不会把图片 Base64 或签名地址写入日志。</p>
        </>}
        {selected === 'tts' && <>
          {config.provider !== 'fish' && <label>音色<input value={String(config.voice ?? '')} onChange={(e) => update('voice', e.target.value)} /></label>}
          <label>语速<input type="number" step="0.1" value={String(config.speed ?? '')} onChange={(e) => update('speed', Number(e.target.value))} /></label>
          <label>
            输出格式
            <select value={String(config.format ?? 'mp3')} onChange={(e) => update('format', e.target.value)}>
              {['mp3', 'wav', 'opus', 'aac', 'flac'].map((format) => <option key={format} value={format}>{format}</option>)}
            </select>
          </label>
          <label>最大重试次数<input type="number" min="0" max="5" value={String(config.maxRetries ?? '')} onChange={(e) => update('maxRetries', Number(e.target.value))} /></label>
          <label className="admin-form-wide">
            情绪投递方式
            <select value={String(config.emotionMode ?? 'auto')} onChange={(e) => update('emotionMode', e.target.value)}>
              <option value="auto">自动（按音色 ID 判断，推荐）</option>
              <option value="instruction">自然语言指令（豆包 2.0「指令遵循」音色）</option>
              <option value="enum">emotion 枚举（仅「多情感」音色，ID 带 _emo_）</option>
              <option value="off">不传情绪</option>
            </select>
            <small>两种音色家族收情绪的方式不一样。自动模式看音色 ID 里有没有 <code>_emo_</code>，换音色就自动跟着切。</small>
          </label>
          <label className="admin-form-wide">
            Resource-Id（仅火山官方协议）
            <input value={String(config.resourceId ?? '')} placeholder="seed-tts-2.0" onChange={(e) => update('resourceId', e.target.value)} />
            <small>它同时决定模型版本和计费商品。官方说明：语音模型不支持通过 Auto 或控制台切换，必须在这里指定。</small>
          </label>
          <label>情绪强度（仅枚举方式，1~5）<input type="number" step="1" min="1" max="5" value={String(config.emotionScale ?? 4)} onChange={(e) => update('emotionScale', Number(e.target.value))} /></label>
        </>}
        {selected === 'tts' && config.provider === 'fish' && <>
          <label className="admin-form-wide">
            Reference-Id（Fish 声线 ID）
            <input value={String((config as Record<string, unknown>).referenceId ?? '')} placeholder="例如 f729a143b9a34005bdae0b21697fa41a" onChange={(e) => update('referenceId', e.target.value)} />
            <small>Fish 持久声线 ID（voice model）。留空则使用 Fish 默认音色。</small>
          </label>
          <label className="admin-form-wide">
            API Key 环境变量名
            <input value={String((config as Record<string, unknown>).apiKeyEnv ?? '')} placeholder="FISH_API_KEY" onChange={(e) => update('apiKeyEnv', e.target.value)} />
            <small>密钥不写入 models.json，从该环境变量读取。例如 FISH_API_KEY。</small>
          </label>
          <label>采样温度（0.55–0.75 角色更稳）<input type="number" step="0.05" min="0" max="2" value={String((config as Record<string, unknown>).temperature ?? 0.65)} onChange={(e) => update('temperature', Number(e.target.value))} /></label>
          <label>Top-P<input type="number" step="0.05" min="0" max="1" value={String((config as Record<string, unknown>).topP ?? 0.7)} onChange={(e) => update('topP', Number(e.target.value))} /></label>
          <label>分块长度（字符）<input type="number" step="10" min="50" max="500" value={String((config as Record<string, unknown>).chunkLength ?? 200)} onChange={(e) => update('chunkLength', Number(e.target.value))} /></label>
          <label>
            延迟模式
            <select value={String((config as Record<string, unknown>).latency ?? 'balanced')} onChange={(e) => update('latency', e.target.value)}>
              <option value="balanced">balanced（自动/主动语音，默认）</option>
              <option value="normal">normal（明确语音请求/预览）</option>
              <option value="low">low（最低延迟）</option>
            </select>
          </label>
          <label><span>normalize（数字/单位更稳）</span><input type="checkbox" checked={Boolean((config as Record<string, unknown>).normalize ?? true)} onChange={(e) => update('normalize', e.target.checked)} /></label>
          <label><span>normalizeLoudness（响度归一）</span><input type="checkbox" checked={Boolean((config as Record<string, unknown>).normalizeLoudness ?? true)} onChange={(e) => update('normalizeLoudness', e.target.checked)} /></label>
          <label><span>conditionOnPreviousChunks（长文本音色一致）</span><input type="checkbox" checked={Boolean((config as Record<string, unknown>).conditionOnPreviousChunks ?? true)} onChange={(e) => update('conditionOnPreviousChunks', e.target.checked)} /></label>
          <label>repetitionPenalty<input type="number" step="0.1" min="0" max="2" value={String((config as Record<string, unknown>).repetitionPenalty ?? 1.2)} onChange={(e) => update('repetitionPenalty', Number(e.target.value))} /></label>
          <label>prosodyVolume（0 不增益）<input type="number" step="1" min="-20" max="20" value={String((config as Record<string, unknown>).prosodyVolume ?? 0)} onChange={(e) => update('prosodyVolume', Number(e.target.value))} /></label>
        </>}
        {selected === 'tts' && (
          <section className="admin-card admin-form-wide" data-testid="admin-tts-preview">
            <div className="admin-card-heading"><h3>语音试听</h3><small>用当前已保存的 TTS 配置试听；Fish 会按所选情绪编译一条安全 cue。</small></div>
            <label>试听文字<textarea value={previewText} onChange={(e) => setPreviewText(e.target.value)} /></label>
            <label>
              情绪测试
              <select value={previewEmotion} onChange={(e) => setPreviewEmotion(e.target.value)}>
                <option value="auto">自动</option>
                <option value="warm">warm · 温暖</option>
                <option value="happy">happy · 开心</option>
                <option value="gentle">gentle · 温柔</option>
                <option value="sleepy">sleepy · 困倦</option>
                <option value="playful">playful · 俏皮</option>
                <option value="serious">serious · 认真</option>
                <option value="shy">shy · 害羞</option>
                <option value="reassuring">reassuring · 安抚</option>
                <option value="neutral">neutral · 中性</option>
              </select>
            </label>
            <button type="button" data-testid="admin-tts-preview-play" disabled={previewing} onClick={() => void previewVoice()}>{previewing ? '试听中…' : '试听'}</button>
            <audio ref={previewAudioRef} controls style={{ display: previewUrlRef.current ? undefined : 'none' }} />
          </section>
        )}
        {selected === 'embedding' && <label>向量维度<input type="number" value={String(config.dimensions ?? '')} onChange={(e) => update('dimensions', Number(e.target.value))} /></label>}
        {selected === 'rerank' && <label>重排候选数（向量初筛取前 N 条送去重排）<input type="number" min="2" max="50" value={String(config.candidateLimit ?? 16)} onChange={(e) => update('candidateLimit', Number(e.target.value))} /></label>}
        <div className="admin-actions">
          {selected === 'image' && <small className="admin-muted">测试出图会真实调用图片服务并消耗一次额度。</small>}
          <button type="button" onClick={() => void save()}>保存模型配置</button>
          <button type="button" data-testid="admin-model-test" disabled={testing} onClick={() => void runTest()}>{testing ? '测试中…' : '测试连接'}</button>
          <button type="button" data-testid="admin-model-add-preset" onClick={() => void addToLibrary()}>存入模型库</button>
        </div>
        {testResult ? (
          <p className={testResult.ok ? 'admin-test-result ok' : 'admin-test-result fail'} data-testid="admin-model-test-result">{testResult.text}</p>
        ) : (
          <small className="admin-muted">「测试连接」会用已保存的配置真发一次最小请求。改了表单要先保存再测。</small>
        )}
        </>}
      </div>
    </section>
  );
}

function ContentPanel({ onNotice }: { onNotice: (v: string) => void }) {
  const [memories, setMemories] = useState<AdminMemory[]>([]);
  const [recall, setRecall] = useState<AdminRecallTrace | null>(null);
  const [stickers, setStickers] = useState<AdminSticker[]>([]);
  const [media, setMedia] = useState<AdminMedia[]>([]);

  const load = useCallback(async () => {
    try {
      const [m, s, d] = await Promise.all([adminApi.memories(), adminApi.stickers(), adminApi.media()]);
      setMemories(m.memories);
      setRecall(m.recall ?? null);
      setStickers(s.stickers);
      setMedia(d.media);
    } catch (e) {
      onNotice(errorText(e));
    }
  }, [onNotice]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="admin-content" data-testid="admin-content">
      <article className="admin-card" data-testid="admin-memory-list">
        <div className="admin-card-subtitle"><h2>记忆</h2><span className="admin-count-badge">{memories.length}</span></div>
        {memories.length ? memories.slice(0, 8).map((m) => <div className="admin-list-row" key={m.id}><span>{m.content}</span><button type="button" onClick={() => void adminApi.deleteMemory(m.id).then(load).catch((e) => onNotice(errorText(e)))}>删除</button></div>) : <EmptyState>暂无长期记忆</EmptyState>}
        <div className="admin-actions"><button type="button" className="admin-danger" onClick={() => { if (confirmAction('确认清空全部记忆？')) void adminApi.clearMemories().then(load).catch((e) => onNotice(errorText(e))); }}>清空记忆</button></div>
      </article>

      {recall && <article className="admin-card" data-testid="admin-memory-recall">
        <div className="admin-card-subtitle"><h2>最近一次记忆召回</h2><span>{recallStrategyLabel(recall.strategy)}</span></div>
        <p>查询：{recall.query || '（无）'}</p>
        <p>候选 {recall.stats.recalled} · 纳入 {recall.stats.included} · 去重 {recall.stats.deduplicated} · 超预算 {recall.stats.budgetDropped}</p>
        {recall.fallbackReason && <p>回退原因：{recallFallbackLabel(recall.fallbackReason)}</p>}
        {recall.entries.slice(0, 8).map((entry) => <div className="admin-list-row" key={entry.id}>
          <span>{entry.included ? '已纳入' : `已丢弃（${recallDropLabel(entry.droppedReason)}）`} · {MEMORY_KIND_LABELS[entry.kind] ?? entry.kind} · {entry.content}</span>
          <small>{recallStrategyLabel(entry.strategy)} · {recallMatchReasonLabel(entry.reason)}</small>
        </div>)}
        {!recall.entries.length && <EmptyState>最近一次没有召回记忆</EmptyState>}
      </article>}

      <article className="admin-card" data-testid="admin-sticker-list">
        <div className="admin-card-subtitle"><h2>表情包</h2><span className="admin-count-badge">{stickers.length}</span></div>
        {stickers.length ? <>
          <div className="admin-actions">
            <button type="button" onClick={() => void adminApi.analyzeStickerBatch().then((result) => { onNotice(`已排队 ${result.queued} 个表情包分析任务`); return load(); }).catch((e) => onNotice(errorText(e)))}>补齐/更新语义</button>
          </div>
          {stickers.slice(0, 20).map((sticker) => <StickerAdminRow key={sticker.id} sticker={sticker} onDone={load} onNotice={onNotice} />)}
        </> : <EmptyState>暂无表情包</EmptyState>}
        <StickerUpload onDone={load} onNotice={onNotice} />
      </article>

      <article className="admin-card" data-testid="admin-media-list">
        <div className="admin-card-subtitle"><h2>媒体文件</h2><span className="admin-count-badge">{media.length}</span></div>
        {media.length ? media.slice(0, 8).map((m) => <div className="admin-list-row" key={m.id}><span>{MEDIA_KIND_LABELS[m.kind] ?? m.kind} · {m.id.slice(-8)} · {formatBytes(m.bytes)}</span><button type="button" onClick={() => { if (confirmAction(`删除媒体 ${m.id.slice(-8)}？`)) void adminApi.deleteMedia(m.id).then(load).catch((e) => onNotice(errorText(e))); }}>删除</button></div>) : <EmptyState>暂无媒体文件</EmptyState>}
      </article>

      <article className="admin-card">
        <h2>聊天记录</h2>
        <p>永久会话仅支持整体清空，避免误删单条上下文造成记忆断裂。</p>
        <div className="admin-actions"><button type="button" className="admin-danger" onClick={() => { if (confirmAction('确认清空全部聊天记录？此操作不可撤销。')) void adminApi.clearChat().then(() => onNotice('聊天记录已清空')).catch((e) => onNotice(errorText(e))); }}>清空聊天记录</button></div>
      </article>
    </section>
  );
}

function stickerStatusLabel(status: AdminSticker['analysisStatus']): string {
  return status === 'ready' ? '语义就绪' : status === 'processing' ? '分析中' : status === 'failed' ? '分析失败' : '待分析';
}

function StickerAdminRow({ sticker, onDone, onNotice }: { sticker: AdminSticker; onDone: () => Promise<void>; onNotice: (text: string) => void }) {
  const [description, setDescription] = useState(sticker.description ?? '');
  const [userMeaning, setUserMeaning] = useState(sticker.userMeaning ?? '');
  const [busy, setBusy] = useState(false);
  const saveSemantics = async () => {
    setBusy(true);
    try {
      await adminApi.updateSticker(sticker.id, { description, userMeaning });
      onNotice(`已保存「${sticker.name}」的语义`);
      await onDone();
    } catch (error) {
      onNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const analyze = async () => {
    setBusy(true);
    try {
      await adminApi.analyzeSticker(sticker.id, true);
      onNotice(`已排队分析「${sticker.name}」`);
      await onDone();
    } catch (error) {
      onNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  return <div className="admin-sticker-row" data-testid={`admin-sticker-${sticker.id}`}>
    <div className="admin-list-row">
      <span><strong>{sticker.name}</strong> · {emotionLabel(sticker.emotion)} · {stickerStatusLabel(sticker.analysisStatus)}{sticker.hasEmbedding ? ' · 已建向量' : ''}</span>
      <span className="admin-actions">
        <button type="button" disabled={busy || sticker.analysisStatus === 'processing'} onClick={() => void analyze()}>AI 重分析</button>
        <button type="button" className="admin-danger" onClick={() => { if (confirmAction(`删除表情包“${sticker.name}”？`)) void adminApi.deleteSticker(sticker.id).then(onDone).catch((e) => onNotice(errorText(e))); }}>删除</button>
      </span>
    </div>
    <details>
      <summary>查看/编辑语义</summary>
      <p className="admin-muted">{sticker.description || '暂无图像含义'}{sticker.imageText ? ` · 图片文字：${sticker.imageText}` : ''}</p>
      {sticker.analysisError && <p className="admin-inline-error">分析错误：{sticker.analysisError}</p>}
      <label>标准含义<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <label>用户常见用法<textarea value={userMeaning} onChange={(event) => setUserMeaning(event.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void saveSemantics()}>保存语义</button>
    </details>
  </div>;
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

type AdminErrorGroup = {
  key: string;
  count: number;
  latest: AdminError;
  title: string;
  explanation: string;
};

function operationAreaLabel(scope: string): string {
  if (scope === 'job.sticker.analyze' || scope.includes('sticker.analy')) return '表情包 AI 分析';
  if (scope.includes('sticker')) return '表情包处理';
  if (scope.includes('moment') || scope.includes('proactive')) return '动态发布';
  if (scope.includes('life')) return '生活状态更新';
  if (scope.includes('weather')) return '天气更新';
  if (scope.includes('image')) return '图片生成';
  if (scope.includes('tts') || scope.includes('voice')) return '语音处理';
  if (scope.includes('push')) return '消息推送';
  if (scope.includes('chat') || scope.includes('reply')) return '聊天回复';
  if (scope.includes('memory') || scope.includes('embedding') || scope.includes('rerank')) return '记忆系统';
  if (scope.includes('database') || scope.includes('sqlite') || scope.includes('db')) return '数据库';
  return '后台任务';
}

function operationErrorCopy(error: AdminError): { title: string; explanation: string } {
  const area = operationAreaLabel(error.scope);
  const message = error.message.toLowerCase();

  if (message.includes('invalid_analysis_json')) {
    return {
      title: '表情包 AI 分析结果格式异常',
      explanation: '视觉模型返回的数据格式不符合要求，本次分析结果没有保存。若持续出现，建议检查视觉模型配置或输出格式。'
    };
  }
  if (/timeout|timed out|etimedout/.test(message)) {
    return {
      title: `${area}超时`,
      explanation: '上游服务在限定时间内没有返回结果。系统会按任务策略重试，持续出现时再检查接口速度或网络。'
    };
  }
  if (/rate.?limit|too many requests|\b429\b/.test(message)) {
    return {
      title: `${area}请求过于频繁`,
      explanation: '上游服务触发了频率限制。通常等待一会儿即可恢复，频繁发生时需要降低并发或提高额度。'
    };
  }
  if (/unauthor|forbidden|invalid.?key|\b401\b|\b403\b/.test(message)) {
    return {
      title: `${area}鉴权失败`,
      explanation: '服务拒绝了当前凭据。请检查对应模型或服务的 API Key、权限和接口地址。'
    };
  }
  if (/not configured|unconfigured|provider.*config|missing.*key/.test(message)) {
    return {
      title: `${area}尚未配置完整`,
      explanation: '这项能力缺少必要配置，因此任务没有继续执行。请到对应设置页补齐服务地址、模型或密钥。'
    };
  }
  if (/fetch failed|network|econn|socket|dns|connection/.test(message)) {
    return {
      title: `${area}连接失败`,
      explanation: '系统没有成功连到上游服务。持续出现时请检查网络、代理、接口地址以及服务是否可用。'
    };
  }
  if (/json|parse|schema|invalid.*format/.test(message)) {
    return {
      title: `${area}返回格式异常`,
      explanation: '上游返回的内容与系统预期格式不一致，本次结果没有采用。技术详情里保留了原始错误码。'
    };
  }
  if (/not found|missing|enoent|\b404\b/.test(message)) {
    return {
      title: `${area}所需资源不存在`,
      explanation: '任务引用的资源或上游地址没有找到。可先检查对应媒体、配置或服务地址是否仍然有效。'
    };
  }

  return {
    title: `${area}出现异常`,
    explanation: '系统记录到一次异常。这里先显示可读摘要，原始错误码和详细数据收在“查看技术详情”里。'
  };
}

function groupAdminErrors(errors: AdminError[]): AdminErrorGroup[] {
  const groups = new Map<string, AdminErrorGroup>();
  for (const error of errors) {
    const copy = operationErrorCopy(error);
    // Group by the problem a human can act on, not by raw backend code. Several
    // parser/provider variants can describe the same visible failure mode.
    const key = copy.title;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, count: 1, latest: error, ...copy });
      continue;
    }
    existing.count += 1;
    if (Date.parse(error.createdAt) > Date.parse(existing.latest.createdAt)) existing.latest = error;
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt));
}

function operationDetailText(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail.trim() || null;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function operationJobLabel(type: string): string {
  if (type.includes('sticker') && type.includes('analy')) return '表情包 AI 分析';
  if (type.includes('sticker')) return '表情包处理';
  if (type.includes('moment') || type.includes('proactive')) return '动态发布';
  if (type.includes('life')) return '生活状态更新';
  if (type.includes('weather')) return '天气更新';
  if (type.includes('image')) return '图片生成';
  if (type.includes('tts') || type.includes('voice')) return '语音处理';
  if (type.includes('push')) return '消息推送';
  if (type.includes('reply') || type.includes('chat')) return '聊天回复';
  return '后台任务';
}

function operationJobStatus(status: string): string {
  const value = status.toLowerCase();
  if (['queued', 'pending'].includes(value)) return '等待处理';
  if (['running', 'processing', 'leased'].includes(value)) return '处理中';
  if (['completed', 'done', 'success', 'succeeded'].includes(value)) return '已完成';
  if (['failed', 'dead'].includes(value)) return '失败';
  if (['cancelled', 'canceled'].includes(value)) return '已取消';
  if (value.includes('retry')) return '等待重试';
  return status;
}

type AdminJobGroup = {
  key: string;
  label: string;
  status: string;
  count: number;
  latest: AdminJob;
};

function groupAdminJobs(jobs: AdminJob[]): AdminJobGroup[] {
  const groups = new Map<string, AdminJobGroup>();
  for (const job of jobs) {
    const label = operationJobLabel(job.type);
    const status = operationJobStatus(job.status);
    const key = `${label}\u0000${status}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, label, status, count: 1, latest: job });
      continue;
    }
    existing.count += 1;
    if (Date.parse(job.updated_at) > Date.parse(existing.latest.updated_at)) existing.latest = job;
  }

  const priority = (status: string) => status === '失败' ? 0 : status === '处理中' ? 1 : status === '等待重试' ? 2 : status === '等待处理' ? 3 : 4;
  return [...groups.values()].sort((a, b) => {
    const delta = priority(a.status) - priority(b.status);
    return delta || Date.parse(b.latest.updated_at) - Date.parse(a.latest.updated_at);
  });
}

function OperationsPanel({ onNotice }: { onNotice: (v: string) => void }) {
  const [errors, setErrors] = useState<AdminError[]>([]);
  const [jobs, setJobs] = useState<AdminJob[]>([]);
  const [backups, setBackups] = useState<AdminBackup[]>([]);

  const groupedErrors = useMemo(() => groupAdminErrors(errors), [errors]);
  const groupedJobs = useMemo(() => groupAdminJobs(jobs), [jobs]);

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
        <div className="admin-card-subtitle">
          <h2>最近错误</h2>
          <span className="admin-count-badge">{errors.length ? `${groupedErrors.length} 类 · ${errors.length} 次` : '0'}</span>
        </div>
        {errors.length ? (
          <div className="admin-log-scroll admin-error-groups">
            {groupedErrors.map((group) => {
              const detail = operationDetailText(group.latest.detail);
              return (
                <details className="admin-error-group" key={group.key}>
                  <summary className="admin-error-summary">
                    <span><strong>{group.title}</strong><small>最近：{formatAdminDateTime(group.latest.createdAt)}</small></span>
                    <b>{group.count} 次</b>
                  </summary>
                  <p>{group.explanation}</p>
                  <div className="admin-error-technical">
                    <strong>技术详情</strong>
                    <code>{group.latest.scope} · {group.latest.message}</code>
                    {detail && <pre>{detail}</pre>}
                  </div>
                </details>
              );
            })}
          </div>
        ) : <EmptyState>暂无错误记录</EmptyState>}
        <div className="admin-log-footer"><button type="button" className="admin-danger" onClick={() => { if (confirmAction('确认清空错误记录？')) void run(() => adminApi.clearErrors(), '错误记录已清空'); }}>清空错误记录</button></div>
      </article>

      <article className="admin-card" data-testid="admin-job-list">
        <div className="admin-card-subtitle"><h2>后台任务</h2><span className="admin-count-badge">{jobs.length}</span></div>
        {jobs.length ? (
          <div className="admin-log-scroll admin-job-groups">
            {groupedJobs.map((group) => (
              <div className="admin-list-row admin-job-readable" key={group.key} title={`${group.latest.type} · ${group.latest.status}`}>
                <span><strong>{group.label}</strong><small>{group.status} · 最近 {formatAdminDateTime(group.latest.updated_at)}</small></span>
                <span className="admin-job-count">{group.count} 个</span>
              </div>
            ))}
          </div>
        ) : <EmptyState>暂无后台任务</EmptyState>}
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
    <MetricsSummary />
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

  useEffect(() => {
    const onUnauthorized = () => {
      clearAdminToken();
      setToken(null);
      setData(null);
    };
    window.addEventListener(ADMIN_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(ADMIN_UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const setDirtyState = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);

  useEffect(() => {
    const routeTab = tabFromAdminPath(window.location.pathname, initialTab);
    const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/admin';
    const preserveLegacyContent = routeTab === 'content' && normalizedPath === '/admin/content' && initialTab === 'content';
    const canonicalPath = preserveLegacyContent || (routeTab === 'content' && isContentSubroute(normalizedPath))
      ? window.location.pathname
      : adminPathForTab(routeTab);
    if (window.location.pathname !== canonicalPath) {
      navigate(canonicalPath, { replace: true });
    }

    const onPopState = () => {
      const next = tabFromAdminPath(window.location.pathname, initialTab);
      if (dirtyRef.current && !window.confirm('当前修改尚未保存，确定离开吗？')) {
        navigate(adminPathForTab(tab));
        return;
      }
      setDirtyState(false);
      setTab(next);
    };
    // In-app navigation (pushState + APP_NAVIGATION_EVENT) never fires
    // popstate; without this listener the URL changes but the panel keeps
    // rendering the old tab.
    const onAppNavigation = () => {
      if (!window.location.pathname.startsWith('/admin')) return;
      setTab(tabFromAdminPath(window.location.pathname, initialTab));
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener(APP_NAVIGATION_EVENT, onAppNavigation);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener(APP_NAVIGATION_EVENT, onAppNavigation);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [initialTab, setDirtyState, tab]);

  const navigateTab = useCallback((next: Tab) => {
    if (next === tab) return;
    if (dirtyRef.current && !window.confirm('当前修改尚未保存，确定离开吗？')) return;
    setDirtyState(false);
    navigate(adminPathForTab(next));
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

  // 子页各自加载自己的数据；不能为了头像/语音页先阻塞等待三项概览请求。
  useEffect(() => {
    if (tab === 'overview' && !data) void loadOverview();
  }, [data, loadOverview, tab]);

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

  const confirmRouteLeave = useCallback((event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!dirtyRef.current) return;
    if (!window.confirm('当前修改尚未保存，确定离开吗？')) {
      event.preventDefault();
      return;
    }
    setDirtyState(false);
  }, [setDirtyState]);

  const counts = useMemo(
    () => data ? capabilityCounts(data.capabilities.capabilities) : { available: 0, total: 0 },
    [data]
  );

  if (!token) {
    return <main className="admin-page admin-v2 admin-lock-page" data-testid="admin-lock"><form className="admin-lock-card" onSubmit={submitToken}><span className="admin-lock-icon"><Icon name="lock" /></span><span className="admin-eyebrow">SOOYA 管理中心</span><h1>输入管理令牌</h1><p>令牌只保存在当前设备，用于访问管理接口。</p><label htmlFor="admin-token">管理令牌</label><input id="admin-token" type="password" autoComplete="current-password" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} /><button type="submit" disabled={!tokenInput.trim()}>进入管理中心</button></form></main>;
  }

  const page = PAGE_COPY[tab];
  const content = tab === 'overview'
    ? data
      ? <Overview data={data} counts={counts} onRefresh={() => void loadOverview()} />
      : <section className="admin-overview-state" aria-live="polite">{loading ? <><div className="admin-spinner" />正在读取系统状态…</> : <><p>{notice ?? '无法加载管理信息'}</p><button type="button" onClick={() => void loadOverview()}>重试</button></>}</section>
    : tab === 'persona'
      ? <><PersonaPanel onNotice={setNotice} /><VoiceBehaviorEditor onNotice={setNotice} /><ReferencesEditor onNotice={setNotice} /></>
      : tab === 'avatar'
        ? <AvatarPanel onNotice={setNotice} />
        : tab === 'life'
            ? <LifeObservationPanel onNotice={setNotice} />
            : tab === 'models'
                ? <ModelsPanel onNotice={setNotice} />
                : tab === 'mcp'
                  ? <McpAdminPage onNotice={setNotice} />
                : tab === 'content'
                  ? isContentSubroute(window.location.pathname) ? <ContentManagementPage onNotice={setNotice} /> : <ContentPanel onNotice={setNotice} />
                  : tab === 'storage'
                    ? <StorageEditor onNotice={setNotice} />
                    : <OperationsPanel onNotice={setNotice} />;

  return (
    <main className="admin-page admin-v2" data-testid="admin-dashboard" data-dirty={dirty || undefined} onInputCapture={(event) => {
      const target = event.target as HTMLInputElement;
      if (target instanceof HTMLInputElement && target.type === 'file') return;
      if (target.closest('.admin-content-management, .admin-mcp-page')) return;
      setDirtyState(true);
    }} onSubmitCapture={() => setDirtyState(false)}>
      <div className="admin-shell">
        {!isMobile && <aside className="admin-sidebar">
          <div className="admin-brand"><span className="admin-brand-mark">S</span><span className="admin-brand-copy"><strong>SOOYA</strong><small>管理中心</small></span></div>
          <TabButtons tab={tab} setTab={navigateTab} mobile={false} />
          <div className="admin-sidebar-footer">
            <AppLink className="admin-side-action" href="/" data-testid="admin-return-chat" onClick={confirmRouteLeave}>返回对话</AppLink>
            <button type="button" className="admin-side-action subtle" onClick={logout}>退出管理</button>
          </div>
        </aside>}

        {isMobile && <header className="admin-mobile-header"><div className="admin-mobile-brand"><span className="admin-mobile-icon"><Icon name={TABS.find((item) => item.id === tab)?.icon ?? 'overview'} /></span><div><strong>SOOYA 管理中心</strong><small>{page.title}</small></div></div><AppLink className="admin-return" href="/" data-testid="admin-return-chat" onClick={confirmRouteLeave}>返回对话</AppLink></header>}

        <section className="admin-main">
          <div className="admin-main-inner">
            {isMobile && <TabButtons tab={tab} setTab={navigateTab} mobile />}
            {!isMobile && <header className="admin-content-header"><div className="admin-title-wrap"><span className="admin-eyebrow">SOOYA ADMIN</span><h1>{page.title}</h1><p>{page.description}</p></div></header>}
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
