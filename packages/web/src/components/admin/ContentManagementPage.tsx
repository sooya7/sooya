import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { AuthenticatedAudio, AuthenticatedImage } from '../AuthenticatedMedia.js';
import { mediaThumbnailPath } from '../../lib/authenticatedMedia.js';
import { adminApi, type AdminActivityItem, type AdminChatMessage, type AdminMedia, type AdminMemory, type AdminOmbreStatus, type AdminSticker } from '../../lib/admin.js';
import { featureApi } from '../../lib/features.js';
import { navigate, APP_NAVIGATION_EVENT } from '../../lib/navigation.js';
import { AdminState, adminStateFromError } from './AdminState.js';
import { ModalSheet } from './ModalSheet.js';

type ContentTab = 'memory' | 'stickers' | 'media' | 'chat';
const CONTENT_TABS: Array<{ id: ContentTab; label: string }> = [
  { id: 'memory', label: '她的记忆' },
  { id: 'stickers', label: '表情包' },
  { id: 'media', label: '媒体库' },
  { id: 'chat', label: '聊天记录' }
];

function currentTab(): ContentTab {
  const segment = window.location.pathname.split('/')[3] as ContentTab | undefined;
  return CONTENT_TABS.some((item) => item.id === segment) ? segment! : 'memory';
}

function dateText(value: string | null | undefined): string {
  if (!value) return '暂无';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : value;
}

function formatBytes(value: number | undefined): string {
  const bytes = Number(value ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ContentSubnav({ tab, onChange }: { tab: ContentTab; onChange: (next: ContentTab) => void }) {
  return <nav className="admin-content-subnav" aria-label="内容管理子页面">
    {CONTENT_TABS.map((item) => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'active' : ''} onClick={() => onChange(item.id)}>{item.label}</button>)}
  </nav>;
}

function PageFrame({ title, description, children, actions }: { title: string; description: string; children: ReactNode; actions?: ReactNode }) {
  return <section className="admin-content-page"><header className="admin-subpage-header"><div><span className="admin-eyebrow">CONTENT</span><h2>{title}</h2><p>{description}</p></div>{actions}</header>{children}</section>;
}

function MemoryPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [status, setStatus] = useState<AdminOmbreStatus | null>(null);
  const [activity, setActivity] = useState<AdminActivityItem[]>([]);
  const [legacy, setLegacy] = useState<{ memories: AdminMemory[]; total: number } | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Array<Record<string, unknown>> | null>(null);
  const [catalog, setCatalog] = useState<Record<string, unknown> | null>(null);
  const [catalogState, setCatalogState] = useState<'idle' | 'loading' | 'available' | 'unsupported'>('idle');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextActivity, nextLegacy] = await Promise.all([adminApi.ombreStatus(), adminApi.ombreActivity(50), adminApi.legacyMemories(100)]);
      setStatus(nextStatus);
      setActivity(nextActivity.activity);
      setLegacy(nextLegacy);
      setError(null);
    } catch (cause) {
      const mapped = adminStateFromError(cause);
      setError(mapped.message);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const result = await adminApi.ombreSearch(query.trim(), 10);
      setResults(result.results.length ? result.results : [{ raw: result.raw }]);
      setActivity((await adminApi.ombreActivity(50)).activity);
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : 'Ombre 搜索失败');
    } finally {
      setSearching(false);
    }
  };

  const browseCatalog = async () => {
    setCatalogState('loading');
    try {
      setCatalog(await adminApi.ombreCatalog(50));
      setCatalogState('available');
    } catch (cause) {
      if (cause instanceof Error && 'status' in cause && (cause as { status?: number }).status === 409) setCatalogState('unsupported');
      else { setCatalogState('unsupported'); onNotice(cause instanceof Error ? cause.message : '目录暂不可用'); }
    }
  };

  return <PageFrame title="她的记忆" description="长期记忆由 Ombre Brain 管理；SOOYA 只提供安全搜索、轻量活动和回滚观察。">
    {error && <AdminState kind="error" message={error} onRetry={() => void load()} />}
    {status && <section className="admin-memory-status" data-testid="admin-ombre-status">
      <article className="admin-card"><span className="admin-card-kicker">连接状态</span><strong>{status.connection === 'connected' ? 'Ombre Brain' : 'Ombre Brain · degraded'}</strong><span className={`admin-status-chip ${status.connection === 'connected' ? 'is-ready' : 'is-warn'}`}>{status.connection === 'connected' ? '已连接' : '降级'}</span></article>
      <article className="admin-card"><span className="admin-card-kicker">最近记忆提交</span><strong>{status.lastCommit ? String(status.lastCommit.state ?? '已记录') : '暂无'}</strong><small>{status.lastCommit ? `不确定 ${status.uncertain} · 待处理 ${status.pending}` : '暂无本地提交记录'}</small></article>
      <article className="admin-card"><span className="admin-card-kicker">最近整理</span><strong>{dateText(status.lastDream)}</strong><small>Dashboard {status.dashboardUrl ? <a href={status.dashboardUrl} target="_blank" rel="noreferrer">打开</a> : '仅服务器本地可用或未配置'}</small></article>
    </section>}
    <section className="admin-card admin-memory-search">
      <div className="admin-card-heading"><div><h3>搜索她的记忆</h3><p>查询通过 Ombre MCP 的只读 breath_search；搜索结果不会进入回复上下文。</p></div></div>
      <form onSubmit={search} className="admin-inline-search"><input aria-label="搜索她的记忆" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：她喜欢的事情…" /><button type="submit" disabled={searching || !query.trim()}>{searching ? '搜索中…' : '搜索'}</button></form>
      {results && <div className="admin-memory-results">{results.map((result, index) => <article className="admin-memory-result" key={`${index}-${String(result.bucketId ?? '')}`}><strong>{typeof result.bucketId === 'string' ? `bucket ${result.bucketId}` : '记忆结果'}</strong><p>{String(result.raw ?? '')}</p>{typeof result.score === 'number' && <small>score {result.score}</small>}</article>)}</div>}
      <div className="admin-actions"><button type="button" onClick={() => void browseCatalog()} disabled={catalogState === 'loading'}>{catalogState === 'loading' ? '读取目录中…' : '浏览记忆目录'}</button>{catalogState === 'unsupported' && <span className="admin-muted">当前 Ombre schema 未提供 catalog 能力</span>}</div>
      {catalog && <pre className="admin-safe-pre">{JSON.stringify(catalog, null, 2)}</pre>}
    </section>
    <section className="admin-card"><div className="admin-card-heading"><div><h3>最近记忆活动</h3><p>仅保留安全摘要，不展示 prompt、tool args 或完整记忆正文。</p></div></div>{activity.length ? activity.map((item) => <div className="admin-list-row" key={item.id}><span><strong>{item.type}</strong><small>{JSON.stringify(item.detail)}</small></span><small>{dateText(item.createdAt)}</small></div>) : <AdminState kind="empty" message="暂无 Ombre 活动" />}</section>
    <details className="admin-card admin-legacy-memory"><summary>旧 SOOYA 记忆 · 只读回滚观察（{legacy?.total ?? 0}）</summary><p>当前 Ombre 模式不读取、不编辑、不删除这批数据。</p>{legacy?.memories.map((memory) => <div className="admin-list-row" key={memory.id}><span>{memory.content}</span><small>{memory.kind} · {dateText(memory.updatedAt)}</small></div>)}</details>
  </PageFrame>;
}

function StickerPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [items, setItems] = useState<AdminSticker[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<{ status: Record<string, number>; source: Record<string, number>; emotion: Record<string, number> } | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [emotion, setEmotion] = useState('');
  const [selected, setSelected] = useState<AdminSticker | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await adminApi.adminStickers({ q: query, status: status || undefined, source: source || undefined, emotion: emotion || undefined, limit: 40, sort: 'created' });
      setItems(result.stickers); setTotal(result.total); setFacets(result.facets);
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : '表情包加载失败'); }
    finally { setLoading(false); }
  }, [emotion, onNotice, query, source, status]);
  useEffect(() => { void load(); }, [load]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('name', uploadFile.name.replace(/\.[^.]+$/u, ''));
      form.append('emotion', emotion || 'neutral');
      form.append('tags', emotion || 'neutral');
      form.append('file', uploadFile);
      await adminApi.uploadSticker(form);
      setUploadFile(null);
      onNotice('表情包已上传');
      await load();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : '上传失败'); }
    finally { setUploading(false); }
  };
  const analyzeBatch = async () => {
    try {
      const result = await adminApi.analyzeStickerBatch();
      onNotice(`已排队 ${result.queued} 个表情包分析任务`);
      await load();
    } catch (cause) { onNotice(cause instanceof Error ? cause.message : '批量分析失败'); }
  };
  return <PageFrame title="表情包" description="以视觉网格浏览；卡片保持轻量，完整语义和分析操作放在详情抽屉。" actions={<span className="admin-count-badge">{total}</span>}>
    <div className="admin-content-toolbar"><input aria-label="搜索表情包" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、标签或语义" /><select aria-label="分析状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="pending">待分析</option><option value="processing">分析中</option><option value="ready">已就绪</option><option value="failed">失败</option></select><select aria-label="来源" value={source} onChange={(event) => setSource(event.target.value)}><option value="">全部来源</option><option value="manual">手动</option><option value="ai">AI</option><option value="legacy">旧数据</option></select><input aria-label="情绪" value={emotion} onChange={(event) => setEmotion(event.target.value)} placeholder="情绪" /><button type="button" onClick={() => void load()} disabled={loading}>应用</button><button type="button" onClick={() => void analyzeBatch()} disabled={loading}>批量分析</button><label className="admin-file-action">+ 上传<input type="file" accept="image/*" onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)} /></label><button type="button" onClick={() => void upload()} disabled={!uploadFile || uploading}>{uploading ? '上传中…' : '确认上传'}</button></div>
    {facets && <div className="admin-filter-facets"><span>待分析 {facets.status.pending ?? 0}</span><span>失败 {facets.status.failed ?? 0}</span><span>AI {facets.source.ai ?? 0}</span></div>}
    {loading ? <AdminState kind="loading" /> : items.length === 0 ? <AdminState kind="empty" message="没有符合条件的表情包" /> : <div className="admin-sticker-grid" data-testid="admin-sticker-grid">{items.map((sticker) => <button type="button" className="admin-sticker-card" key={sticker.id} onClick={() => setSelected(sticker)}><AuthenticatedImage path={mediaThumbnailPath(sticker.url, 240)} scope="admin" alt={sticker.name} /><span className="admin-sticker-card-copy"><strong>{sticker.name}</strong><small>{sticker.emotion} · {sticker.analysisStatus ?? 'pending'}</small><small>使用 {sticker.useCount ?? 0} 次 · {sticker.enabled === false ? '已禁用' : '启用'}</small></span></button>)}</div>}
    <ModalSheet open={Boolean(selected)} title="表情详情" onClose={() => setSelected(null)} description="详情抽屉只在打开时保留选中项；保存和重新分析沿用现有受控 API。" testId="sticker-detail">{selected && <StickerDetail sticker={selected} onNotice={onNotice} onDone={async () => { setSelected(null); await load(); }} />}</ModalSheet>
  </PageFrame>;
}

function StickerDetail({ sticker, onNotice, onDone }: { sticker: AdminSticker; onNotice: (message: string) => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState(sticker.name);
  const [emotion, setEmotion] = useState(sticker.emotion);
  const [enabled, setEnabled] = useState(sticker.enabled);
  const [saving, setSaving] = useState(false);
  const save = async () => { setSaving(true); try { await adminApi.updateSticker(sticker.id, { name, emotion, enabled }); onNotice('表情包已保存'); await onDone(); } catch (cause) { onNotice(cause instanceof Error ? cause.message : '保存失败'); } finally { setSaving(false); } };
  const analyze = async () => { try { await adminApi.analyzeSticker(sticker.id, true); onNotice('已重新排队分析'); await onDone(); } catch (cause) { onNotice(cause instanceof Error ? cause.message : '分析排队失败'); } };
  return <div className="admin-sticker-detail"><AuthenticatedImage path={sticker.url} scope="admin" alt={sticker.name} /><label>名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>情绪<input value={emotion} onChange={(event) => setEmotion(event.target.value)} /></label><label className="admin-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用表情包</label><dl><dt>分析状态</dt><dd>{sticker.analysisStatus ?? 'pending'} / {sticker.analysisSource ?? 'legacy'}</dd><dt>AI 描述</dt><dd>{sticker.description || '暂无'}</dd><dt>用户含义</dt><dd>{sticker.userMeaning || '暂无'}</dd><dt>使用次数</dt><dd>{sticker.useCount ?? 0}</dd></dl><div className="admin-actions"><button type="button" onClick={() => void analyze()}>重新分析</button><button type="button" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存'}</button></div></div>;
}

function MediaPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [items, setItems] = useState<AdminMedia[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [origin, setOrigin] = useState('');
  const [state, setState] = useState<'active' | 'trashed' | 'all'>('active');
  const [selected, setSelected] = useState<AdminMedia | null>(null);
  const [usage, setUsage] = useState<{ usageCount: number; references: Record<string, number>; avatar: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); try { const result = await adminApi.adminMedia({ q: query, kind: kind || undefined, origin: origin || undefined, state, limit: 40 }); setItems(result.media); setTotal(result.total); } catch (cause) { onNotice(cause instanceof Error ? cause.message : '媒体库加载失败'); } finally { setLoading(false); } }, [kind, onNotice, origin, query, state]);
  useEffect(() => { void load(); }, [load]);
  const open = async (item: AdminMedia) => { setSelected(item); try { setUsage(await adminApi.mediaUsage(item.id)); } catch (cause) { onNotice(cause instanceof Error ? cause.message : '媒体引用加载失败'); } };
  const trash = async (item: AdminMedia) => { try { await featureApi.trashMedia(item.id); onNotice('媒体已移入回收站'); await load(); setSelected(null); } catch (cause) { onNotice(cause instanceof Error ? cause.message : '媒体回收失败'); } };
  const restore = async (item: AdminMedia) => { try { await featureApi.restoreMedia(item.id); onNotice('媒体已恢复'); await load(); setSelected(null); } catch (cause) { onNotice(cause instanceof Error ? cause.message : '媒体恢复失败'); } };
  const removePermanently = async (item: AdminMedia) => { if (!window.confirm('确认永久删除这个媒体？该操作不可撤销。')) return; try { await featureApi.deleteMedia(item.id); onNotice('媒体已永久删除'); await load(); setSelected(null); } catch (cause) { onNotice(cause instanceof Error ? cause.message : '媒体永久删除失败'); } };
  return <PageFrame title="媒体库" description="查看图片、音频、表情和文件的预览、来源与引用；被引用或作为头像的媒体不会被回收。" actions={<span className="admin-count-badge">{total}</span>}>
    <div className="admin-content-toolbar"><input aria-label="搜索媒体" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名、标签或消息内容" /><select aria-label="媒体类型" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option><option value="image">图片</option><option value="audio">音频</option><option value="sticker">表情</option><option value="file">文件</option></select><select aria-label="媒体来源" value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">全部来源</option><option value="upload">上传</option><option value="generated">生成</option><option value="builtin">内置</option><option value="remote">远程</option></select><select aria-label="媒体状态" value={state} onChange={(event) => setState(event.target.value as typeof state)}><option value="active">当前媒体</option><option value="trashed">回收站</option><option value="all">全部</option></select><button type="button" onClick={() => void load()} disabled={loading}>应用</button></div>
    {loading ? <AdminState kind="loading" /> : items.length === 0 ? <AdminState kind="empty" message="没有符合条件的媒体" /> : <div className="admin-media-grid" data-testid="admin-media-grid">{items.map((item) => <button type="button" className="admin-media-card" key={item.id} onClick={() => void open(item)}>{item.kind === 'image' || item.kind === 'sticker' ? <AuthenticatedImage path={mediaThumbnailPath(item.url, 240)} scope="admin" alt={item.name ?? item.id} /> : <span className="admin-media-file" aria-label={`${item.kind} 文件`}>{item.kind.toUpperCase()}</span>}<span><strong>{item.name ?? item.id.slice(-12)}</strong><small>{item.origin} · {formatBytes(item.bytes)}</small><small>引用 {item.usageCount ?? 0}</small></span></button>)}</div>}
    <ModalSheet open={Boolean(selected)} title="媒体详情" onClose={() => setSelected(null)} description="媒体引用由服务端统一检查；详情页不会把引用关系隐藏在前端缓存里。" testId="media-detail">{selected && <div className="admin-media-detail">{selected.kind === 'image' || selected.kind === 'sticker' ? <AuthenticatedImage path={selected.url} scope="admin" alt={selected.name ?? selected.id} /> : selected.kind === 'audio' ? <AuthenticatedAudio path={selected.url} scope="admin" aria-label={selected.name ?? selected.id} /> : <div className="admin-media-file large">{selected.kind.toUpperCase()}</div>}<dl><dt>ID</dt><dd>{selected.id}</dd><dt>来源</dt><dd>{selected.origin}</dd><dt>大小</dt><dd>{formatBytes(selected.bytes)}</dd><dt>使用情况</dt><dd>{usage ? `${usage.usageCount} 个引用${usage.avatar ? ' · 头像保护' : ''}` : '读取中…'}</dd></dl>{usage && <pre className="admin-safe-pre">{JSON.stringify(usage.references, null, 2)}</pre>}<div className="admin-actions">{selected.deletedAt ? <><button type="button" onClick={() => void restore(selected)}>恢复</button><button type="button" className="admin-danger" onClick={() => void removePermanently(selected)} disabled={Boolean(usage?.usageCount) || Boolean(usage?.avatar)}>永久删除</button></> : <button type="button" onClick={() => void trash(selected)} disabled={Boolean(usage?.usageCount) || Boolean(usage?.avatar)}>移入回收站</button>}</div></div>}</ModalSheet>
  </PageFrame>;
}

function messageText(message: AdminChatMessage): string {
  return message.content.map((part) => part.text ?? part.transcript ?? (part.media ? `[${part.media.kind}]` : '')).filter(Boolean).join(' ');
}

function ChatPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [messages, setMessages] = useState<AdminChatMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'user' | 'assistant' | ''>('');
  const [hasMedia, setHasMedia] = useState('');
  const [selected, setSelected] = useState<AdminChatMessage | null>(null);
  const [context, setContext] = useState<AdminChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { setLoading(true); try { const result = await adminApi.chatHistory({ q: query, role: role || undefined, hasMedia: hasMedia === '' ? undefined : hasMedia === 'true', limit: 40 }); setMessages(result.messages); setTotal(result.total); } catch (cause) { onNotice(cause instanceof Error ? cause.message : '聊天记录加载失败'); } finally { setLoading(false); } }, [hasMedia, onNotice, query, role]);
  useEffect(() => { void load(); }, [load]);
  const open = async (message: AdminChatMessage) => { setSelected(message); try { const result = await adminApi.chatContext(message.id, 5, 5); setContext(result.messages); } catch (cause) { onNotice(cause instanceof Error ? cause.message : '上下文加载失败'); } };
  return <PageFrame title="聊天记录" description="独立查看 user/assistant 消息，支持文本、日期、角色和媒体筛选；系统及内部工具轨迹不在此展示。" actions={<span className="admin-count-badge">{total}</span>}>
    <div className="admin-content-toolbar"><input aria-label="搜索聊天内容" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索聊天内容" /><select aria-label="消息角色" value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="">全部角色</option><option value="user">用户</option><option value="assistant">SOOYA</option></select><select aria-label="是否含媒体" value={hasMedia} onChange={(event) => setHasMedia(event.target.value)}><option value="">全部消息</option><option value="true">含媒体</option><option value="false">无媒体</option></select><button type="button" onClick={() => void load()} disabled={loading}>应用</button></div>
    {loading ? <AdminState kind="loading" /> : messages.length === 0 ? <AdminState kind="empty" message="没有符合条件的聊天记录" /> : <div className="admin-chat-history" data-testid="admin-chat-history">{messages.map((message) => <button type="button" className="admin-chat-row" key={message.id} onClick={() => void open(message)}><span className={`admin-chat-role ${message.role}`}>{message.role === 'user' ? '你' : 'SOOYA'}</span><span><strong>{messageText(message) || '（媒体消息）'}</strong><small>{dateText(message.createdAt)} · {message.content.length} 个内容块</small></span></button>)}</div>}
    <ModalSheet open={Boolean(selected)} title="消息上下文" onClose={() => setSelected(null)} description="这里只展示相邻 user/assistant 消息，不暴露系统消息或工具调用历史。" testId="chat-context">{selected && <div className="admin-chat-context">{context.map((message) => <article key={message.id} className={`admin-chat-context-row ${message.id === selected.id ? 'selected' : ''}`}><strong>{message.role === 'user' ? '你' : 'SOOYA'}</strong><p>{messageText(message) || '（媒体消息）'}</p><small>{dateText(message.createdAt)}</small></article>)}</div>}</ModalSheet>
  </PageFrame>;
}

export function ContentManagementPage({ onNotice }: { onNotice: (message: string) => void }) {
  const [tab, setTab] = useState<ContentTab>(() => currentTab());
  useEffect(() => { const update = () => setTab(currentTab()); window.addEventListener(APP_NAVIGATION_EVENT, update); window.addEventListener('popstate', update); return () => { window.removeEventListener(APP_NAVIGATION_EVENT, update); window.removeEventListener('popstate', update); }; }, []);
  const changeTab = (next: ContentTab) => { navigate(`/admin/content/${next}`); setTab(next); };
  const page = useMemo(() => tab === 'memory' ? <MemoryPage onNotice={onNotice} /> : tab === 'stickers' ? <StickerPage onNotice={onNotice} /> : tab === 'media' ? <MediaPage onNotice={onNotice} /> : <ChatPage onNotice={onNotice} />, [onNotice, tab]);
  return <section className="admin-content-management" data-testid="admin-content-management"><ContentSubnav tab={tab} onChange={changeTab} />{page}</section>;
}
