import { useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, getAdminToken, setAdminToken, type AdminPersona } from '../lib/admin.js';
import { adminMediaUrl, featureApi, type WorldEntry } from '../lib/features.js';

const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'gentle'] as const;
const EMOTION_LABELS: Record<string, string> = { neutral: '中性', happy: '开心', sad: '难过', angry: '生气', gentle: '温柔' };

function bytes(value: unknown): string {
  const n = Number(value ?? 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}

function AvatarEditor({ persona, onPersona, onNotice }: { persona: AdminPersona; onPersona: (p: AdminPersona) => void; onNotice: (s: string) => void }) {
  const upload = async (slot: 'assistant' | 'user', file?: File) => {
    if (!file) return;
    try {
      const result = await featureApi.uploadAvatar(slot, file);
      onPersona({ ...persona, avatar: result.persona.avatar, userAvatar: result.persona.userAvatar });
      onNotice(`${slot === 'assistant' ? 'SOOYA' : '用户'}头像已更新`);
    } catch (error) { onNotice(errorText(error)); }
  };
  return (
    <section className="admin-form-card" data-testid="avatar-settings">
      <div className="admin-panel-heading"><div><h2>双方头像</h2><p>分别上传 SOOYA 与用户头像，保存后聊天页面会即时刷新。</p></div></div>
      <div className="admin-summary">
        <label className="admin-card"><strong>SOOYA 头像</strong><img src={adminMediaUrl(persona.avatar)} alt="SOOYA 头像预览" style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover' }} /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => void upload('assistant', e.target.files?.[0])} /></label>
        <label className="admin-card"><strong>用户头像</strong><img src={adminMediaUrl(persona.userAvatar)} alt="用户头像预览" style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover' }} /><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => void upload('user', e.target.files?.[0])} /></label>
      </div>
    </section>
  );
}

function VoiceEditor({ onNotice }: { onNotice: (s: string) => void }) {
  const [data, setData] = useState<Record<string, any> | null>(null);
  const [text, setText] = useState('你好呀，我是 SOOYA。');
  const [emotion, setEmotion] = useState('neutral');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const load = () => featureApi.voice().then(setData).catch((e) => onNotice(errorText(e)));
  useEffect(() => { void load(); }, []);
  const policy = data?.policy ?? {};
  const model = data?.model ?? {};
  const emotions = data?.emotions ?? {};
  const setPolicy = (key: string, value: unknown) => setData((prev) => prev ? { ...prev, policy: { ...prev.policy, [key]: value } } : prev);
  const setModel = (key: string, value: unknown) => setData((prev) => prev ? { ...prev, model: { ...prev.model, [key]: value } } : prev);
  const save = async () => {
    if (!data) return;
    try { setData(await featureApi.updateVoice({ policy: data.policy, model: data.model, emotions: data.emotions })); onNotice('情绪语音配置已保存并立即生效'); }
    catch (error) { onNotice(errorText(error)); }
  };
  const preview = async () => {
    try {
      const blob = await featureApi.previewVoice(text, emotion);
      const url = URL.createObjectURL(blob);
      if (audioRef.current) { audioRef.current.src = url; await audioRef.current.play(); }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { onNotice(errorText(error)); }
  };
  if (!data) return <section className="admin-card">正在读取语音能力…</section>;
  const capability = data.capability ?? {};
  return (
    <section className="admin-form-card" data-testid="voice-settings">
      <div className="admin-panel-heading"><div><h2>情绪语音</h2><p>{capability.ok || capability.configured ? 'TTS 能力可用' : `TTS 不可用：${capability.detail ?? '尚未配置'}`}</p></div></div>
      <label><span>启用语音</span><input type="checkbox" checked={Boolean(policy.enabled)} onChange={(e) => setPolicy('enabled', e.target.checked)} /></label>
      <label>发送频率<select value={String(policy.frequency ?? 'medium')} onChange={(e) => setPolicy('frequency', e.target.value)}><option value="never">从不</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      <label>单段最大字符<input type="number" min={20} max={2000} value={Number(policy.maxCharsPerClip ?? 300)} onChange={(e) => setPolicy('maxCharsPerClip', Number(e.target.value))} /></label>
      <label><span>附带文字</span><input type="checkbox" checked={Boolean(policy.alwaysAttachTranscript)} onChange={(e) => setPolicy('alwaysAttachTranscript', e.target.checked)} /></label>
      <label>默认音色<input value={String(model.voice ?? '')} onChange={(e) => setModel('voice', e.target.value)} /></label>
      <label>默认语速<input type="number" min={0.25} max={4} step={0.05} value={Number(model.speed ?? 1)} onChange={(e) => setModel('speed', Number(e.target.value))} /></label>
      <div className="admin-form-wide"><strong>情绪映射</strong>{EMOTIONS.map((key) => { const item = emotions[key] ?? { label: EMOTION_LABELS[key], instructions: '', speed: 1 }; return <div className="admin-list-row" key={key}><span>{item.label ?? EMOTION_LABELS[key]}</span><input aria-label={`${key}提示`} value={String(item.instructions ?? '')} onChange={(e) => setData({ ...data, emotions: { ...emotions, [key]: { ...item, instructions: e.target.value } } })} /><input aria-label={`${key}语速`} type="number" step={0.05} min={0.25} max={4} value={Number(item.speed ?? 1)} onChange={(e) => setData({ ...data, emotions: { ...emotions, [key]: { ...item, speed: Number(e.target.value) } } })} /></div>; })}</div>
      <div className="admin-card"><strong>试听</strong><textarea value={text} onChange={(e) => setText(e.target.value)} /><select value={emotion} onChange={(e) => setEmotion(e.target.value)}>{EMOTIONS.map((key) => <option key={key} value={key}>{EMOTION_LABELS[key]}</option>)}</select><button type="button" disabled={!capability.ok && !capability.configured} onClick={() => void preview()}>试听</button><audio ref={audioRef} controls /></div>
      <div className="admin-actions"><button type="button" onClick={() => void save()}>保存语音配置</button></div>
    </section>
  );
}

function WorldEditor({ onNotice }: { onNotice: (s: string) => void }) {
  const [entries, setEntries] = useState<WorldEntry[]>([]);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState({ kind: 'fact', subject: '', predicate: '', object: '' });
  const importRef = useRef<HTMLInputElement | null>(null);
  const load = () => featureApi.world({ search, limit: 200 }).then((r) => setEntries(r.entries)).catch((e) => onNotice(errorText(e)));
  useEffect(() => { void load(); }, []);
  const create = async () => {
    try { await featureApi.createWorld(draft as any); setDraft({ kind: 'fact', subject: '', predicate: '', object: '' }); await load(); onNotice('世界条目已创建'); }
    catch (error) { onNotice(errorText(error)); }
  };
  const exportData = async () => {
    try { const data = await featureApi.exportWorld(); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `sooya-world-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url); }
    catch (error) { onNotice(errorText(error)); }
  };
  const importData = async (file?: File) => {
    if (!file) return;
    try { await featureApi.importWorld(JSON.parse(await file.text())); await load(); onNotice('世界数据已导入'); }
    catch (error) { onNotice(errorText(error)); }
  };
  return (
    <section className="admin-form-card" data-testid="world-settings">
      <div className="admin-panel-heading"><div><h2>世界引擎</h2><p>查看、搜索、编辑、禁用、删除、导入与重建持久化世界状态。</p></div></div>
      <div className="admin-actions"><input placeholder="搜索实体、关系或事实" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void load(); }} /><button type="button" onClick={() => void load()}>搜索</button><button type="button" onClick={() => void featureApi.rebuildWorld().then(() => onNotice('世界重建任务已进入队列')).catch((e) => onNotice(errorText(e)))}>从对话重建</button><button type="button" onClick={() => void exportData()}>导出</button><button type="button" onClick={() => importRef.current?.click()}>导入</button><input ref={importRef} hidden type="file" accept="application/json" onChange={(e) => void importData(e.target.files?.[0])} /></div>
      <div className="admin-list-row"><select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}><option value="entity">实体</option><option value="relation">关系</option><option value="fact">事实</option><option value="scene">场景</option><option value="timeline">时间线</option></select><input placeholder="主体" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /><input placeholder="关系/属性" value={draft.predicate} onChange={(e) => setDraft({ ...draft, predicate: e.target.value })} /><input placeholder="内容" value={draft.object} onChange={(e) => setDraft({ ...draft, object: e.target.value })} /><button type="button" disabled={!draft.subject || !draft.predicate || !draft.object} onClick={() => void create()}>新增</button></div>
      {entries.length === 0 ? <div className="admin-empty">暂无匹配的世界条目</div> : entries.map((entry) => <div className="admin-list-row" key={entry.id}><span><strong>{entry.subject}</strong> · {entry.predicate} → {entry.object}<small> {entry.kind} / {entry.authority}{entry.conflict_of ? ' / 冲突候选' : ''}</small></span><button type="button" onClick={() => void featureApi.updateWorld(entry.id, { active: !(entry.active === 1 || entry.active === true) }).then(load).catch((e) => onNotice(errorText(e)))}>{entry.active === 1 || entry.active === true ? '禁用' : '启用'}</button><button type="button" className="admin-danger" onClick={() => { if (window.confirm('确认删除该世界条目？')) void featureApi.deleteWorld(entry.id).then(load).catch((e) => onNotice(errorText(e))); }}>删除</button></div>)}
    </section>
  );
}

function StorageEditor({ onNotice }: { onNotice: (s: string) => void }) {
  const [data, setData] = useState<Record<string, any> | null>(null);
  const [report, setReport] = useState<Record<string, any> | null>(null);
  const load = () => featureApi.storage().then(setData).catch((e) => onNotice(errorText(e)));
  useEffect(() => { void load(); }, []);
  const policy = data?.policy ?? {};
  const setPolicy = (key: string, value: number) => setData((prev) => prev ? { ...prev, policy: { ...prev.policy, [key]: value } } : prev);
  const preview = async (apply: boolean) => {
    try { const result = await featureApi.cleanupStorage(apply); setReport(result); await load(); onNotice(apply ? `清理完成，释放 ${bytes(result.releasedBytes)}` : '清理预览已生成，尚未删除任何内容'); }
    catch (error) { onNotice(errorText(error)); }
  };
  if (!data) return <section className="admin-card">正在读取存储状态…</section>;
  return (
    <section className="admin-form-card" data-testid="storage-settings">
      <div className="admin-panel-heading"><div><h2>存储治理</h2><p>当前媒体 {bytes(data.mediaBytes)}，备份 {bytes(data.backupBytes)}，可用空间 {data.freeBytes == null ? '未知' : bytes(data.freeBytes)}。</p></div></div>
      {data.warning && <div className="admin-inline-error">已达到{data.warning === 'hard' ? '硬' : '软'}限额</div>}
      <label>软限额（MB）<input type="number" value={Math.round(Number(policy.softLimitBytes ?? 0) / 1024 / 1024)} onChange={(e) => setPolicy('softLimitBytes', Number(e.target.value) * 1024 * 1024)} /></label>
      <label>硬限额（MB）<input type="number" value={Math.round(Number(policy.hardLimitBytes ?? 0) / 1024 / 1024)} onChange={(e) => setPolicy('hardLimitBytes', Number(e.target.value) * 1024 * 1024)} /></label>
      <label>回收站保留天数<input type="number" value={Number(policy.trashRetentionDays ?? 30)} onChange={(e) => setPolicy('trashRetentionDays', Number(e.target.value))} /></label>
      <label>临时文件保留小时<input type="number" value={Number(policy.tempRetentionHours ?? 24)} onChange={(e) => setPolicy('tempRetentionHours', Number(e.target.value))} /></label>
      <label>备份保留份数<input type="number" value={Number(policy.backupKeep ?? 7)} onChange={(e) => setPolicy('backupKeep', Number(e.target.value))} /></label>
      <div className="admin-actions"><button type="button" onClick={() => void featureApi.updateStorage(policy).then(() => { void load(); onNotice('存储策略已保存'); }).catch((e) => onNotice(errorText(e)))}>保存策略</button><button type="button" onClick={() => void preview(false)}>预览清理</button><button type="button" className="admin-danger" disabled={!report || report.applied} onClick={() => { if (window.confirm('只会删除预览报告中仍满足安全条件的项目，确认执行？')) void preview(true); }}>执行安全清理</button></div>
      {report && <pre style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(report.report ?? report, null, 2)}</pre>}
    </section>
  );
}

export default function FeatureAdminPage() {
  const [token, setTokenState] = useState(() => getAdminToken() ?? '');
  const [authorized, setAuthorized] = useState(() => Boolean(getAdminToken()));
  const [persona, setPersona] = useState<AdminPersona | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'avatar' | 'voice' | 'world' | 'storage'>('avatar');
  useEffect(() => { if (authorized) void adminApi.persona().then((r) => setPersona(r.persona)).catch((e) => setNotice(errorText(e))); }, [authorized]);
  const title = useMemo(() => ({ avatar: '头像', voice: '情绪语音', world: '世界引擎', storage: '存储治理' }[tab]), [tab]);
  if (!authorized) return <main className="admin-page admin-v2 admin-lock-page"><form className="admin-lock-card" onSubmit={(e) => { e.preventDefault(); if (!token.trim()) return; setAdminToken(token.trim()); setAuthorized(true); }}><h1>SOOYA 功能中心</h1><p>输入管理令牌以管理 1–9 功能。</p><input type="password" value={token} onChange={(e) => setTokenState(e.target.value)} /><button type="submit">进入</button></form></main>;
  return (
    <main className="admin-page admin-v2">
      <div className="admin-shell">
        <aside className="admin-sidebar"><div className="admin-brand"><span className="admin-brand-mark">S</span><span className="admin-brand-copy"><strong>SOOYA</strong><small>1–9 功能中心</small></span></div><nav className="admin-side-nav">{(['avatar', 'voice', 'world', 'storage'] as const).map((id) => <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}><span className="admin-nav-copy"><strong>{{ avatar: '双方头像', voice: '情绪语音', world: '世界引擎', storage: '存储治理' }[id]}</strong></span></button>)}</nav><div className="admin-sidebar-footer"><a className="admin-side-action" href="/gallery">图库与回收站</a><a className="admin-side-action" href="/admin">基础管理面板</a><a className="admin-side-action" href="/">返回聊天</a></div></aside>
        <section className="admin-main"><header className="admin-topbar"><div><span className="admin-eyebrow">SOOYA 1–9</span><h1>{title}</h1></div></header>{notice && <div className="admin-inline-error" role="status">{notice}</div>}<div className="admin-content-area">{tab === 'avatar' && persona && <AvatarEditor persona={persona} onPersona={setPersona} onNotice={setNotice} />}{tab === 'voice' && <VoiceEditor onNotice={setNotice} />}{tab === 'world' && <WorldEditor onNotice={setNotice} />}{tab === 'storage' && <StorageEditor onNotice={setNotice} />}</div></section>
      </div>
    </main>
  );
}
