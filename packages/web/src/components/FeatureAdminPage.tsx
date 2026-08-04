import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdminPersona } from '../lib/admin.js';
import { adminMediaUrl, featureApi, type LifePanelData, type LifeSettings, type PersonaReference } from '../lib/features.js';
import { formatGap, herClock, reachReasonText, slotProgress, sortedLog } from '../lib/lifeView.js';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';

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

export function AvatarEditor({ persona, onPersona, onNotice }: { persona: AdminPersona; onPersona: (p: AdminPersona) => void; onNotice: (s: string) => void }) {
  const assistantMedia = useAuthenticatedMedia(persona.avatar, 'admin', 'image');
  const userMedia = useAuthenticatedMedia(persona.userAvatar, 'admin', 'image');
  persona = { ...persona, avatar: assistantMedia.url ?? '', userAvatar: userMedia.url ?? '' };
  const upload = async (slot: 'assistant' | 'user', file?: File) => {
    if (!file) return;
    try {
      const result = await featureApi.uploadAvatar(slot, file);
      onPersona({ ...persona, avatar: result.persona.avatar, userAvatar: result.persona.userAvatar });
      onNotice(`${slot === 'assistant' ? 'SOOYA' : '用户'}头像已更新`);
    } catch (error) {
      onNotice(errorText(error));
    }
  };
  return (
    <section className="admin-form-card" data-testid="avatar-settings">
      <div className="admin-panel-heading"><div><p>分别上传 SOOYA 与用户头像。选好文件就会立即上传，聊天页面随即刷新。</p></div></div>
      <div className="admin-summary">
        <label className="admin-card"><strong>SOOYA 头像</strong><img src={adminMediaUrl(persona.avatar)} alt="SOOYA 头像预览" style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover' }} />{assistantMedia.error && <small role="status">{assistantMedia.error}</small>}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void upload('assistant', event.target.files?.[0])} /></label>
        <label className="admin-card"><strong>用户头像</strong><img src={adminMediaUrl(persona.userAvatar)} alt="用户头像预览" style={{ width: 88, height: 88, borderRadius: '50%', objectFit: 'cover' }} />{userMedia.error && <small role="status">{userMedia.error}</small>}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void upload('user', event.target.files?.[0])} /></label>
      </div>
    </section>
  );
}

const FRAMING_LABELS: Record<PersonaReference['framing'], string> = { front: '正面/半身', 'full-body': '全身', side: '侧脸' };
const FRAMING_ORDER: Array<PersonaReference['framing']> = ['front', 'full-body', 'side'];

/*
 * 参考图按视角分三个槽位：往哪个槽位传，系统就自动把它改成该视角的图
 * （后端重命名为带视角线索的规范名），并替换同视角的旧图，不用手改文件名。
 */
export function ReferencesEditor({ onNotice }: { onNotice: (s: string) => void }) {
  const [list, setList] = useState<PersonaReference[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const createdUrls = useRef<string[]>([]);

  const load = () => featureApi.references().then((r) => setList(r.references)).catch((error) => onNotice(errorText(error)));
  useEffect(() => { void load(); }, []);
  useEffect(() => () => { for (const url of createdUrls.current) URL.revokeObjectURL(url); }, []);

  useEffect(() => {
    if (!list) return;
    let cancelled = false;
    for (const ref of list) {
      if (!ref.exists || thumbs[ref.name]) continue;
      void featureApi.referenceData(ref.name).then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        createdUrls.current.push(url);
        setThumbs((prev) => ({ ...prev, [ref.name]: url }));
      }).catch((error) => { if (!cancelled) onNotice(`「${ref.name}」预览加载失败: ${errorText(error)}`); });
    }
    return () => { cancelled = true; };
  }, [list]);

  const upload = async (framing: PersonaReference['framing'], file?: File) => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const result = await featureApi.uploadReferenceSlot(framing, file);
      onNotice(`「${FRAMING_LABELS[framing]}」参考图已更新${result.replaced.length > 0 ? `，替换了 ${result.replaced.join('、')}` : ''}`);
      await load();
    } catch (error) {
      onNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!window.confirm(`删除参考图「${name}」？文件会一并删除，之后生成自拍将不再用它。`)) return;
    try {
      await featureApi.deleteReference(name);
      onNotice('参考图已删除');
      await load();
    } catch (error) {
      onNotice(errorText(error));
    }
  };

  if (!list) return <section className="admin-form-card">正在读取参考图…</section>;
  const slotOf = (framing: PersonaReference['framing']) =>
    list.find((r) => r.framing === framing && r.configured) ?? list.find((r) => r.framing === framing && r.exists);
  return (
    <section className="admin-form-card" data-testid="reference-settings">
      <div className="admin-panel-heading"><div><h2>形象参考图</h2><p>她发自拍时的长相依据。往哪个视角传，就自动成为该视角的参考图（替换旧图），她生成自拍时按内容自动选用。</p></div></div>
      <div className="admin-summary">
        {FRAMING_ORDER.map((framing) => {
          const ref = slotOf(framing);
          return (
            <label className="admin-card" key={framing}>
              <strong>{FRAMING_LABELS[framing]}</strong>
              {ref && thumbs[ref.name]
                ? <img src={thumbs[ref.name]} alt={ref.name} style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 12 }} />
                : <div style={{ width: 120, height: 120, display: 'grid', placeItems: 'center', background: 'rgba(120,120,140,0.12)', borderRadius: 12 }}>{ref ? '无预览' : '未上传'}</div>}
              {ref
                ? <small style={{ wordBreak: 'break-all' }}>{ref.name} · {ref.exists ? bytes(ref.bytes) : '文件缺失'}{ref.configured ? '' : ' · 未启用'}</small>
                : <small>还没有这个视角的参考图</small>}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(event) => { void upload(framing, event.target.files?.[0]); event.target.value = ''; }} />
              {ref && <button type="button" onClick={(event) => { event.preventDefault(); void remove(ref.name); }}>删除</button>}
            </label>
          );
        })}
      </div>
    </section>
  );
}

export function VoiceEditor({ onNotice }: { onNotice: (s: string) => void }) {
  const [data, setData] = useState<Record<string, any> | null>(null);
  const [text, setText] = useState('你好呀，我是 SOOYA。');
  const [emotion, setEmotion] = useState('neutral');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const load = () => featureApi.voice().then(setData).catch((error) => onNotice(errorText(error)));
  useEffect(() => { void load(); }, []);
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);
  const policy = data?.policy ?? {};
  const model = data?.model ?? {};
  const emotions = data?.emotions ?? {};
  const supported = data?.supported ?? {};
  const setPolicy = (key: string, value: unknown) => setData((previous) => previous ? { ...previous, policy: { ...previous.policy, [key]: value } } : previous);
  const setModel = (key: string, value: unknown) => setData((previous) => previous ? { ...previous, model: { ...previous.model, [key]: value } } : previous);
  const save = async () => {
    if (!data) return;
    try {
      setData(await featureApi.updateVoice({ policy: data.policy, model: data.model, emotions: data.emotions }));
      onNotice('情绪语音配置已保存并立即生效');
    } catch (error) {
      onNotice(errorText(error));
    }
  };
  const preview = async () => {
    try {
      const blob = await featureApi.previewVoice(text, emotion);
      const url = URL.createObjectURL(blob);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = url;
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
      }
    } catch (error) {
      onNotice(errorText(error));
    }
  };
  if (!data) return <section className="admin-card">正在读取语音能力…</section>;
  const capability = data.capability ?? {};
  return (
    <section className="admin-form-card" data-testid="voice-settings">
      <div className="admin-panel-heading"><div><p>{capability.ok || capability.configured ? 'TTS 能力可用' : `TTS 不可用：${capability.detail ?? '尚未配置'}`}</p></div></div>
      <label><span>启用语音</span><input type="checkbox" checked={Boolean(policy.enabled)} onChange={(event) => setPolicy('enabled', event.target.checked)} /></label>
      <label>发送频率<select value={String(policy.frequency ?? 'medium')} onChange={(event) => setPolicy('frequency', event.target.value)}><option value="never">从不</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      <label>单段最大字符<input type="number" min={20} max={2000} value={Number(policy.maxCharsPerClip ?? 300)} onChange={(event) => setPolicy('maxCharsPerClip', Number(event.target.value))} /></label>
      <label><span>附带文字</span><input type="checkbox" checked={Boolean(policy.alwaysAttachTranscript)} onChange={(event) => setPolicy('alwaysAttachTranscript', event.target.checked)} /></label>
      <label>默认音色<input value={String(model.voice ?? '')} onChange={(event) => setModel('voice', event.target.value)} disabled={supported.voice === false} /></label>
      <label>默认语速<input type="number" min={0.25} max={4} step={0.05} value={Number(model.speed ?? 1)} onChange={(event) => setModel('speed', Number(event.target.value))} disabled={supported.speed === false} /></label>
      <label>表达模式<select value={String(model.instructionMode ?? 'auto')} onChange={(event) => setModel('instructionMode', event.target.value)} disabled={supported.instructions === false}><option value="on">始终使用情绪提示</option><option value="auto">自动</option><option value="off">关闭</option></select></label>
      <label>情绪强度<input type="number" min={0} max={1} step={0.05} value={Number(model.emotionIntensity ?? 0.7)} onChange={(event) => setModel('emotionIntensity', Number(event.target.value))} disabled={supported.instructions === false} /></label>
      <label>音调<input aria-label="音调" value="当前供应商不支持" disabled /><small>当前 TTS 供应商没有可用的音调参数。</small></label>
      <label>音量<input aria-label="音量" value="当前供应商不支持" disabled /><small>当前 TTS 供应商没有可用的音量参数。</small></label>
      <div className="admin-form-wide"><strong>情绪映射</strong>{EMOTIONS.map((key) => { const item = emotions[key] ?? { label: EMOTION_LABELS[key], instructions: '', speed: 1 }; return <div className="admin-list-row" key={key}><span>{item.label ?? EMOTION_LABELS[key]}</span><input aria-label={`${key}提示`} value={String(item.instructions ?? '')} onChange={(event) => setData({ ...data, emotions: { ...emotions, [key]: { ...item, instructions: event.target.value } } })} disabled={supported.instructions === false} /><input aria-label={`${key}语速`} type="number" step={0.05} min={0.25} max={4} value={Number(item.speed ?? 1)} onChange={(event) => setData({ ...data, emotions: { ...emotions, [key]: { ...item, speed: Number(event.target.value) } } })} disabled={supported.speed === false} /></div>; })}</div>
      <div className="admin-card"><strong>试听</strong><textarea value={text} onChange={(event) => setText(event.target.value)} /><select value={emotion} onChange={(event) => setEmotion(event.target.value)}>{EMOTIONS.map((key) => <option key={key} value={key}>{EMOTION_LABELS[key]}</option>)}</select><button type="button" disabled={!capability.ok && !capability.configured} onClick={() => void preview()}>试听</button><audio ref={audioRef} controls /></div>
      <div className="admin-actions"><button type="button" onClick={() => void save()}>保存语音配置</button></div>
    </section>
  );
}

/*
 * 她的生活。这页存在的理由是「她为什么没说话」只有服务端知道：被上限挡住、在静默
 * 时段、还是没有做完的事可说，从外面看全都是一片安静。所以状态、日志、原因、以及能
 * 改的那几个阈值放在同一屏，看到原因就能直接改旁边的设置。
 */
export function LifePanel({ onNotice }: { onNotice: (s: string) => void }) {
  const [data, setData] = useState<LifePanelData | null>(null);
  const [form, setForm] = useState<LifeSettings | null>(null);
  const [planTitle, setPlanTitle] = useState('');
  const [planKind, setPlanKind] = useState('chore');
  const [busy, setBusy] = useState(false);
  const load = () => featureApi.life().then((result) => { setData(result); setForm(result.settings); }).catch((error) => onNotice(errorText(error)));
  useEffect(() => {
    void load();
    // 她的状态每 5 分钟才推进一次，30 秒刷新足够跟上，又不会把面板变成轮询机器
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(timer);
  }, []);
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await featureApi.updateLifeSettings({
        reachOut: form.reachOut,
        quietGapMinutes: form.quietGapMinutes,
        maxReachOutsPerDay: form.maxReachOutsPerDay,
        silentFrom: form.silentFrom,
        silentTo: form.silentTo,
        proactiveMode: form.proactiveMode
      });
      await load();
      onNotice('生活设置已保存');
    } catch (error) {
      onNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  const addPlan = async () => {
    if (!planTitle.trim()) return;
    setBusy(true);
    try {
      await featureApi.createLifePlan({ title: planTitle.trim(), kind: planKind });
      setPlanTitle('');
      await load();
      onNotice('生活计划已加入');
    } catch (error) {
      onNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };
  if (!data || !form) return <section className="admin-form-card" data-testid="life-settings"><div className="admin-empty">读取中…</div></section>;
  const tz = data.settings.tzOffsetMinutes;
  const progress = slotProgress(data.snapshot);
  const log = sortedLog(data.log);
  return (
    <section className="admin-form-card" data-testid="life-settings">
      <div className="admin-card life-now">
        <div className="admin-card-subtitle"><h2>此刻</h2><span className="admin-count-badge">{herClock(new Date().toISOString(), tz)}</span></div>
        <p className="life-activity">正在<strong>{data.snapshot.activity}</strong>，心情{data.snapshot.mood}</p>
        <div className="life-progress"><i style={{ width: `${progress.percent}%` }} /></div>
        <small>已经 {progress.intoIt}，还有 {progress.left} 换下一件事（{herClock(data.snapshot.startedAt, tz)} – {herClock(data.snapshot.endsAt, tz)}）</small>
        <div className="admin-actions">
          <button type="button" disabled={busy} onClick={() => void featureApi.tickLife().then(() => load()).then(() => onNotice('已推进她的状态')).catch((error) => onNotice(errorText(error)))}>立即推进</button>
        </div>
      </div>

      <div className="admin-card" data-testid="life-reach-out">
        <div className="admin-card-subtitle"><h2>主动开口</h2><span className={`admin-count-badge ${data.reachOut.reach ? 'life-ok' : ''}`}>{data.reachOut.reach ? '就绪' : '暂不'}</span></div>
        <p>{reachReasonText(data)}</p>
        <small>今天已主动 {data.reachOut.sharedLastDay} / {data.settings.maxReachOutsPerDay} 条 · 你上次说话 {data.reachOut.lastUserAt ? `${formatGap(Date.now() - Date.parse(data.reachOut.lastUserAt))}前` : '无记录'}</small>
        {data.reachOut.candidate ? <small>准备说的是：{data.reachOut.candidate.activity}</small> : null}
      </div>

      <div className="admin-card" data-testid="life-plans">
        <div className="admin-card-subtitle"><h2>接下来要做的事</h2><span className="admin-count-badge">{data.plans.length}</span></div>
        <div className="admin-list-row">
          <input aria-label="生活计划" placeholder="例如：整理书桌" value={planTitle} onChange={(event) => setPlanTitle(event.target.value)} />
          <select aria-label="生活计划类型" value={planKind} onChange={(event) => setPlanKind(event.target.value)}>
            <option value="chore">家务</option><option value="out">出门</option><option value="play">玩耍</option><option value="meal">吃饭</option><option value="rest">休息</option>
          </select>
          <button type="button" disabled={busy || !planTitle.trim()} onClick={() => void addPlan()}>加入计划</button>
        </div>
        {data.plans.length === 0 ? <div className="admin-empty">还没有排好的计划。</div> : data.plans.slice(0, 12).map((plan) => (
          <div className="admin-list-row" key={plan.id}>
            <span><strong>{plan.title}</strong><small> · {plan.kind} · {lifePlanStatusText(plan.status)}</small></span>
            <span className="admin-actions">
              {plan.status === 'planned' && <button type="button" onClick={() => void featureApi.updateLifePlan(plan.id, { status: 'active' }).then(() => load()).catch((error) => onNotice(errorText(error)))}>开始</button>}
              {plan.status === 'active' && <button type="button" onClick={() => void featureApi.updateLifePlan(plan.id, { status: 'paused' }).then(() => load()).catch((error) => onNotice(errorText(error)))}>暂停</button>}
              {plan.status === 'paused' && <button type="button" onClick={() => void featureApi.updateLifePlan(plan.id, { status: 'active' }).then(() => load()).catch((error) => onNotice(errorText(error)))}>继续</button>}
              {(plan.status === 'active' || plan.status === 'paused') && <button type="button" onClick={() => void featureApi.updateLifePlan(plan.id, { status: 'completed' }).then(() => load()).catch((error) => onNotice(errorText(error)))}>完成</button>}
            </span>
          </div>
        ))}
      </div>

      <div className="admin-form-wide">
        <strong>规则</strong>
        <div className="admin-list-row">
          <span>允许主动开口</span>
          <input aria-label="允许主动开口" type="checkbox" checked={form.reachOut} onChange={(event) => setForm({ ...form, reachOut: event.target.checked })} />
          <span>安静间隔（分钟）</span>
          <input aria-label="安静间隔" type="number" min={5} max={1440} value={form.quietGapMinutes} onChange={(event) => setForm({ ...form, quietGapMinutes: Number(event.target.value) })} />
        </div>
        <div className="admin-list-row">
          <span>每天最多几条</span>
          <input aria-label="每天最多几条" type="number" min={0} max={20} value={form.maxReachOutsPerDay} onChange={(event) => setForm({ ...form, maxReachOutsPerDay: Number(event.target.value) })} />
          <span>静默时段</span>
          <input aria-label="静默开始" type="number" min={0} max={23} value={form.silentFrom} onChange={(event) => setForm({ ...form, silentFrom: Number(event.target.value) })} />
          <input aria-label="静默结束" type="number" min={0} max={23} value={form.silentTo} onChange={(event) => setForm({ ...form, silentTo: Number(event.target.value) })} />
        </div>
        <div className="admin-list-row">
          <span>主动分享模式</span>
          <select aria-label="主动分享模式" value={form.proactiveMode ?? 'auto'} onChange={(event) => setForm({ ...form, proactiveMode: event.target.value as LifeSettings['proactiveMode'] })}>
            <option value="auto">自动（默认文字优先）</option><option value="text">文字</option><option value="text_sticker">文字＋表情包</option><option value="voice">语音</option><option value="image">图片</option>
          </select>
        </div>
        <div className="admin-actions"><button type="button" disabled={busy} onClick={() => void save()}>保存生活设置</button></div>
      </div>

      <div className="admin-card" data-testid="life-proactive-attempts">
        <div className="admin-card-subtitle"><h2>主动分享记录</h2><span className="admin-count-badge">{data.proactive.length}</span></div>
        {data.proactive.length === 0 ? <div className="admin-empty">还没有主动分享尝试。</div> : data.proactive.slice(0, 12).map((attempt) => (
          <div className="admin-list-row" key={attempt.id}>
            <span><strong>{attempt.candidateActivity ?? '无候选'}</strong><small> · {attempt.requestedMode ?? '未选模式'} → {attempt.finalMode ?? '未发送'}</small></span>
            <small>{attempt.status === 'blocked' ? `阻断：${attempt.blockedReason ?? '未知'}` : attempt.status === 'failed' ? `失败：${attempt.blockedReason ?? attempt.fallbackReason ?? '未知'}` : `${attempt.sendSuccess ? '已发送' : '未发送'} · ${attempt.userResponseMessageId ? '用户已响应' : '未响应'}`}</small>
          </div>
        ))}
      </div>

      <div className="admin-card">
        <div className="admin-card-subtitle"><h2>做过的事</h2><span className="admin-count-badge">{log.length}</span></div>
        {log.length === 0
          ? <EmptyLife />
          : log.map((row) => (
            <div className="admin-list-row" key={row.id}>
              <span>{herClock(row.started_at, tz)}–{herClock(row.ended_at, tz)} · {row.activity}<small> {row.mood}</small></span>
              <small>{row.shared ? '已跟你说过' : '还没说'}</small>
            </div>
          ))}
      </div>

      <div className="admin-card" data-testid="life-events">
        <div className="admin-card-subtitle"><h2>生活事件</h2><span className="admin-count-badge">{data.events.length}</span></div>
        {data.events.length === 0 ? <div className="admin-empty">推进生活状态后，完成的事情会留在这里。</div> : data.events.slice(0, 12).map((event) => (
          <div className="admin-list-row" key={event.id}><span>{event.description}<small> · {event.kind} · {herClock(event.happened_at, tz)}</small></span><small>{event.shareable ? (event.shared_at ? '已分享' : '可分享') : '仅记录'}</small></div>
        ))}
      </div>
    </section>
  );
}

function lifePlanStatusText(status: string): string {
  return ({ planned: '待办', active: '进行中', paused: '已暂停', completed: '已完成', cancelled: '已取消', skipped: '已跳过' } as Record<string, string>)[status] ?? status;
}

/** 一条都没有通常不是坏了：只有换时段那一刻才落一条，睡整夜就是空的。 */
function EmptyLife() {
  return <div className="admin-empty">还没有记录。她每换一件事才记一条，所以刚重启或整夜睡觉时这里是空的。</div>;
}

const CLEANUP_PAGE_SIZE = 50;
const CLEANUP_CATEGORY_LABELS: Record<string, string> = {
  expiredTrash: '过期回收站',
  missingRecords: '缺失文件记录',
  orphanFiles: '孤立文件',
  unreferencedMedia: '未引用媒体',
  tempFiles: '临时文件',
  oldBackups: '旧备份'
};

function cleanupTarget(item: Record<string, unknown>): string {
  return String(item.path ?? item.relPath ?? item.id ?? '未知项目');
}

function CleanupReportView({ result }: { result: Record<string, any> }) {
  const report = (result.report ?? result) as Record<string, any>;
  const [page, setPage] = useState(0);
  const categories = useMemo(() =>
    Object.entries(report.candidates ?? {}).map(([category, raw]) => {
      const items = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
      return {
        category,
        label: CLEANUP_CATEGORY_LABELS[category] ?? category,
        items,
        bytes: items.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0)
      };
    }), [report]
  );
  const details = useMemo(() =>
    categories.flatMap((group) => group.items.map((item) => ({
      category: group.category,
      label: group.label,
      target: cleanupTarget(item),
      bytes: Number(item.bytes ?? 0)
    }))), [categories]
  );
  const pages = Math.max(1, Math.ceil(details.length / CLEANUP_PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const visible = details.slice(safePage * CLEANUP_PAGE_SIZE, (safePage + 1) * CLEANUP_PAGE_SIZE);
  useEffect(() => setPage(0), [result]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${String(report.reportId ?? 'cleanup-report')}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="admin-card admin-form-wide" data-testid="cleanup-report-summary">
      <div className="admin-card-heading"><h2>清理报告摘要</h2><button type="button" onClick={download}>下载完整清理报告</button></div>
      <p>{details.length.toLocaleString('en-US')} 项 · 可释放 {bytes(Number(report.reclaimableBytes ?? result.releasedBytes ?? 0))}</p>
      {report.reportId && <small>报告 ID：{String(report.reportId)}</small>}
      <div className="admin-summary">
        {categories.map((group) => <div className="admin-summary-tile" key={group.category}><span>{group.label}</span><strong>{group.items.length.toLocaleString('en-US')}</strong><small>{bytes(group.bytes)}</small></div>)}
      </div>
      <div>
        {visible.map((item, index) => <div className="admin-list-row" data-testid="cleanup-report-row" key={`${item.category}:${item.target}:${index}`}><span><strong>{item.label}</strong> · {item.target}</span><small>{bytes(item.bytes)}</small></div>)}
        {details.length === 0 && <div className="admin-empty">没有可清理候选</div>}
      </div>
      {pages > 1 && <div className="admin-actions"><button type="button" aria-label="上一页清理明细" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>上一页</button><span>{safePage + 1} / {pages}</span><button type="button" aria-label="下一页清理明细" disabled={safePage >= pages - 1} onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}>下一页</button></div>}
    </section>
  );
}

export function StorageEditor({ onNotice }: { onNotice: (s: string) => void }) {
  const [data, setData] = useState<Record<string, any> | null>(null);
  const [report, setReport] = useState<Record<string, any> | null>(null);
  const load = () => featureApi.storage().then(setData).catch((error) => onNotice(errorText(error)));
  useEffect(() => { void load(); }, []);
  const policy = data?.policy ?? {};
  const setPolicy = (key: string, value: number) => setData((previous) => previous ? { ...previous, policy: { ...previous.policy, [key]: value } } : previous);
  const preview = async (apply: boolean) => {
    try {
      const result = await featureApi.cleanupStorage(apply, undefined, apply ? report?.report?.reportId : undefined);
      setReport(result);
      await load();
      onNotice(apply ? `清理完成，释放 ${bytes(result.releasedBytes)}` : '清理预览已生成，尚未删除任何内容');
    } catch (error) {
      onNotice(errorText(error));
    }
  };
  if (!data) return <section className="admin-card">正在读取存储状态…</section>;
  return (
    <section className="admin-form-card" data-testid="storage-settings">
      <div className="admin-panel-heading"><div><p>当前媒体 {bytes(data.mediaBytes)}，备份 {bytes(data.backupBytes)}，可用空间 {data.freeBytes == null ? '未知' : bytes(data.freeBytes)}。</p></div></div>
      {data.warning && <div className="admin-inline-error">已达到{data.warning === 'hard' ? '硬' : '软'}限额</div>}
      <label>软限额（MB）<input type="number" value={Math.round(Number(policy.softLimitBytes ?? 0) / 1024 / 1024)} onChange={(event) => setPolicy('softLimitBytes', Number(event.target.value) * 1024 * 1024)} /></label>
      <label>硬限额（MB）<input type="number" value={Math.round(Number(policy.hardLimitBytes ?? 0) / 1024 / 1024)} onChange={(event) => setPolicy('hardLimitBytes', Number(event.target.value) * 1024 * 1024)} /></label>
      <label>回收站保留天数<input type="number" value={Number(policy.trashRetentionDays ?? 30)} onChange={(event) => setPolicy('trashRetentionDays', Number(event.target.value))} /></label>
      <label>临时文件保留小时<input type="number" value={Number(policy.tempRetentionHours ?? 24)} onChange={(event) => setPolicy('tempRetentionHours', Number(event.target.value))} /></label>
      <label>备份保留份数<input type="number" value={Number(policy.backupKeep ?? 7)} onChange={(event) => setPolicy('backupKeep', Number(event.target.value))} /></label>
      <div className="admin-actions"><button type="button" onClick={() => void featureApi.updateStorage(policy).then(() => { void load(); onNotice('存储策略已保存'); }).catch((error) => onNotice(errorText(error)))}>保存策略</button><button type="button" onClick={() => void preview(false)}>预览清理</button><button type="button" className="admin-danger" disabled={!report || report.applied} onClick={() => { if (window.confirm('只会删除预览报告中仍满足安全条件的项目，确认执行？')) void preview(true); }}>执行安全清理</button></div>
      {report && <CleanupReportView result={report} />}
    </section>
  );
}
