import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdminPersona } from '../lib/admin.js';
import { adminMediaUrl, featureApi, type LifePanelData, type LifeSettings } from '../lib/features.js';
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
        silentTo: form.silentTo
      });
      await load();
      onNotice('生活设置已保存');
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
        <div className="admin-actions"><button type="button" disabled={busy} onClick={() => void save()}>保存生活设置</button></div>
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
    </section>
  );
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
