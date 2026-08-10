import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdminPersona } from '../lib/admin.js';
import { featureApi, type PersonaReference } from '../lib/features.js';
import { mediaThumbnailPath } from '../lib/authenticatedMedia.js';
import { useAuthenticatedMedia, type AuthenticatedMediaState } from '../lib/useAuthenticatedMedia.js';

const EMOTION_LABELS: Record<string, string> = { neutral: '中性', happy: '开心', sad: '难过', angry: '生气', gentle: '温柔', sleepy: '困倦', confused: '疑惑' };
export function emotionLabel(value: string): string {
  return EMOTION_LABELS[value] ?? value;
}
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

function AvatarPreview({ label, media }: { label: string; media: AuthenticatedMediaState }) {
  if (media.url) return <img className="admin-avatar-preview" src={media.url} alt={`${label}预览`} />;
  if (media.loading) return <span className="admin-avatar-preview-skeleton" role="img" aria-label={`${label}加载中`} />;
  return <>
    <span className="admin-avatar-preview-placeholder" role="img" aria-label={media.error ? `${label}加载失败` : `${label}尚未设置`}><span aria-hidden="true">暂无</span></span>
    {media.error && <small role="status">{media.error}</small>}
    {media.retriable && <button type="button" onClick={media.retry}>重试预览</button>}
  </>;
}

export function AvatarEditor({ persona, onPersona, onNotice }: { persona: AdminPersona; onPersona: (p: AdminPersona) => void; onNotice: (s: string) => void }) {
  // 预览只显示 88px，请求缩略图档位即可，原图动辄几 MB。
  const assistantMedia = useAuthenticatedMedia(persona.avatar ? mediaThumbnailPath(persona.avatar, 88) : persona.avatar, 'admin', 'image');
  const userMedia = useAuthenticatedMedia(persona.userAvatar ? mediaThumbnailPath(persona.userAvatar, 88) : persona.userAvatar, 'admin', 'image');
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
        <div className="admin-card"><strong>SOOYA 头像</strong><AvatarPreview label="SOOYA 头像" media={assistantMedia} /><input aria-label="上传 SOOYA 头像" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void upload('assistant', event.target.files?.[0])} /></div>
        <div className="admin-card"><strong>用户头像</strong><AvatarPreview label="用户头像" media={userMedia} /><input aria-label="上传用户头像" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void upload('user', event.target.files?.[0])} /></div>
      </div>
    </section>
  );
}

const FRAMING_LABELS: Record<PersonaReference['framing'], string> = { front: '正面/半身', 'full-body': '全身', side: '侧脸' };
const FRAMING_ORDER: Array<PersonaReference['framing']> = ['front', 'full-body', 'side'];

/*
 * 参考图按视角分三个槽位：往哪个槽位传，系统就自动把它改成该视角的图
 * （后端重命名为带视角线索的规范名），并替换同视角的旧图，不用手改文件名。
 * bundle 重建标记：用于生成新的资源哈希。
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
                ? <img src={thumbs[ref.name]} alt={ref.name} title={ref.name} style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 12 }} />
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
