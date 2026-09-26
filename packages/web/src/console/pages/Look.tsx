import { useEffect, useRef, useState } from 'react';
import { adminApi, adminRequest, type AdminPersona } from '../../lib/admin.js';
import { featureApi, type PersonaReference } from '../../lib/features.js';
import { mediaThumbnailPath } from '../../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../../lib/useAuthenticatedMedia.js';
import {
  Button, Callout, ConfirmButton, Empty, Loadable, Page, Section, Status, Tag, errorMessage, fmtBytes,
  useAction, useConsole, useLoad
} from '../ui.js';
import './Look.css';

type Framing = PersonaReference['framing'];
type AvatarSlot = 'assistant' | 'user';

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const AVATAR_CSS_WIDTH = 112;

const FRAMINGS: Array<{ id: Framing; label: string; hint: string }> = [
  { id: 'front', label: '正脸或半身', hint: '最常用。自拍、近景都靠这张认脸。' },
  { id: 'full-body', label: '全身', hint: '站着、走路、穿搭这类要看到全身的画面。' },
  { id: 'side', label: '侧脸', hint: '侧面、回头这类画面。' }
];
const FRAMING_LABEL: Record<Framing, string> = { front: '正脸或半身', 'full-body': '全身', side: '侧脸' };

type PersonaWithRefs = AdminPersona & { referenceImages?: string[] };

/* ------------------------------------------------------------ file picker */

/** A button that opens the file chooser; the chosen file is handed over immediately. */
function FilePick({ label, name, busy, disabled, onFile }: {
  label: string; name?: string; busy?: boolean; disabled?: boolean; onFile: (file: File) => void;
}) {
  const off = disabled || busy;
  return (
    <label className="cs-btn look-pick" data-kind="quiet" data-size="sm" aria-busy={busy || undefined} aria-disabled={off || undefined}>
      <input type="file" className="cs-sr" accept={IMAGE_ACCEPT} disabled={off} aria-label={name ?? label}
        onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onFile(file); }} />
      {busy ? '正在上传…' : label}
    </label>
  );
}

/* ---------------------------------------------------------------- avatars */

function isDefaultAvatar(url: string | undefined): boolean {
  return !url || url.startsWith('/avatars/');
}

function AvatarSlotView({ slot, title, url, busy, onUpload }: {
  slot: AvatarSlot; title: string; url: string; busy: boolean; onUpload: (slot: AvatarSlot, file: File) => void;
}) {
  const media = useAuthenticatedMedia(url ? mediaThumbnailPath(url, AVATAR_CSS_WIDTH) : null, 'admin', 'image');
  return (
    <div className="look-avatar">
      <div className="look-avatar-frame">
        {media.url ? <img src={media.url} alt={title} />
          : <span className="look-avatar-empty">{media.loading ? '读取中' : media.error ? '读不出来' : '没有头像'}</span>}
      </div>
      <div className="look-avatar-info">
        <span className="look-avatar-title">{title}</span>
        <span className="cs-muted">{isDefaultAvatar(url) ? '现在用的是默认头像' : '已换成你上传的图片'}</span>
        {media.error && (
          <span className="cs-muted">
            预览没加载出来：{media.error}
            {media.retriable && <> <Button kind="text" size="sm" onClick={media.retry}>重新加载</Button></>}
          </span>
        )}
        <FilePick label={isDefaultAvatar(url) ? '上传头像' : '换一张'} name={`上传${title}`} busy={busy} onFile={(file) => onUpload(slot, file)} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- references */

/** Blob URLs for reference previews; `bump` forces a refetch after a file is overwritten in place. */
function useReferencePreviews(refs: PersonaReference[] | null) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [version, setVersion] = useState<Record<string, number>>({});
  const owned = useRef<Record<string, string>>({});
  const requested = useRef<Record<string, number>>({});

  useEffect(() => () => { for (const url of Object.values(owned.current)) URL.revokeObjectURL(url); }, []);

  useEffect(() => {
    if (!refs) return;
    let cancelled = false;
    for (const ref of refs) {
      const v = version[ref.name] ?? 0;
      if (!ref.exists || requested.current[ref.name] === v) continue;
      requested.current[ref.name] = v;
      void featureApi.referenceData(ref.name).then((blob) => {
        if (cancelled) { delete requested.current[ref.name]; return; }
        const url = URL.createObjectURL(blob);
        const old = owned.current[ref.name];
        if (old) URL.revokeObjectURL(old);
        owned.current[ref.name] = url;
        setUrls((prev) => ({ ...prev, [ref.name]: url }));
        setFailed((prev) => { const next = { ...prev }; delete next[ref.name]; return next; });
      }).catch((error) => {
        if (cancelled) { delete requested.current[ref.name]; return; }
        setFailed((prev) => ({ ...prev, [ref.name]: errorMessage(error) }));
      });
    }
    return () => { cancelled = true; };
  }, [refs, version]);

  const bump = (name: string) => setVersion((prev) => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }));
  return { urls, failed, bump };
}

function refState(ref: PersonaReference): { tone: 'ok' | 'warn' | 'bad'; text: string } {
  if (!ref.exists) return { tone: 'bad', text: '文件不见了' };
  if (!ref.configured) return { tone: 'warn', text: '没在用' };
  return { tone: 'ok', text: '正在用' };
}

function RefPreview({ item, url, failed, onRetry, compact }: {
  item: PersonaReference | undefined; url?: string; failed?: string; onRetry: () => void; compact?: boolean;
}) {
  if (item && url) return <img src={url} alt={`参考图 ${item.name}`} />;
  let text = compact ? '' : '还没有';
  if (item && !item.exists) text = compact ? '无' : '文件不见了';
  else if (item && failed) text = compact ? '' : '预览失败';
  else if (item) text = compact ? '' : '读取中';
  return (
    <span className="look-ref-empty">
      {text}
      {item?.exists && failed && <Button kind="text" size="sm" onClick={onRetry}>重试</Button>}
    </span>
  );
}

/* ================================================================== page */

export default function Look() {
  const { notify } = useConsole();
  const { run, busy } = useAction();
  const persona = useLoad(() => adminApi.persona().then((r) => r.persona as PersonaWithRefs), []);
  const references = useLoad(() => featureApi.references(), []);
  const refs = references.data?.references ?? null;
  const previews = useReferencePreviews(refs);
  const dirMissing = references.data !== null && !references.data.dir;

  const uploadAvatar = async (slot: AvatarSlot, file: File) => {
    const label = slot === 'assistant' ? '她的头像' : '你的头像';
    const result = await run(`avatar-${slot}`, () => featureApi.uploadAvatar(slot, file), `${label}已更新`);
    if (result) persona.setData((old) => old && ({ ...old, avatar: result.persona.avatar, userAvatar: result.persona.userAvatar }));
  };

  /** After any change to the reference files the persona's list changes too. */
  const refreshAll = async () => { await Promise.all([references.reload(), persona.reload()]); };

  const uploadSlot = async (framing: Framing, file: File) => {
    const result = await run(`slot-${framing}`, () => featureApi.uploadReferenceSlot(framing, file));
    if (!result) return;
    notify(result.replaced.length
      ? `${FRAMING_LABEL[framing]}参考图已更新，换掉了 ${result.replaced.join('、')}`
      : `${FRAMING_LABEL[framing]}参考图已更新`, 'ok');
    previews.bump(result.reference.name);
    await refreshAll();
  };

  const uploadLoose = async (file: File) => {
    const result = await run('upload', () => featureApi.uploadReference(file));
    if (!result) return;
    notify(`参考图已上传，保存为 ${result.reference.name}，归到${FRAMING_LABEL[result.reference.framing]}`, 'ok');
    previews.bump(result.reference.name);
    await refreshAll();
  };

  const remove = async (item: PersonaReference) => {
    const { name } = item;
    const result = await run(`delete-${name}`, () => featureApi.deleteReference(name), item.exists ? '参考图已删除' : '记录已移除');
    if (result) await refreshAll();
  };

  /** Toggles whether an existing file is used, without touching the file. */
  const setUsed = async (name: string, used: boolean) => {
    const current = persona.data?.referenceImages ?? refs?.filter((r) => r.configured).map((r) => r.name) ?? [];
    const next = used ? [...current.filter((n) => n !== name), name] : current.filter((n) => n !== name);
    const result = await run(`use-${name}`, () => adminRequest<{ persona: PersonaWithRefs }>('/api/admin/persona', {
      method: 'PUT', body: { referenceImages: next }
    }), used ? '这张参考图已启用' : '这张参考图已停用');
    if (result) { persona.setData(result.persona); await references.reload(); }
  };

  const slotRef = (framing: Framing) =>
    refs?.find((r) => r.framing === framing && r.configured) ?? refs?.find((r) => r.framing === framing && r.exists);

  return (
    <Page title="形象" register="her" intro="聊天里你们俩的头像，以及她发照片、视频时照着画的长相。">
      <Section title="头像" desc="选好图片就会立刻上传，聊天窗口马上换上新头像。旧头像如果没有别处在用，会移到回收站。">
        <Loadable state={persona} label="头像">
          {(p) => (
            <div className="look-avatars">
              <AvatarSlotView slot="assistant" title="她的头像" url={p.avatar} busy={busy === 'avatar-assistant'} onUpload={(s, f) => void uploadAvatar(s, f)} />
              <AvatarSlotView slot="user" title="你的头像" url={p.userAvatar} busy={busy === 'avatar-user'} onUpload={(s, f) => void uploadAvatar(s, f)} />
            </div>
          )}
        </Loadable>
      </Section>

      <Section title="她的长相" desc="生成她的照片和视频时，会按画面内容挑一张参考图照着画，保证每次长得一样。往哪个位置传，就成为那种取景的参考图，并替换掉原来那张。">
        <Loadable state={references} label="参考图">
          {() => (
            <>
              {dirMissing && (
                <Callout tone="warn">
                  服务器上没有可用的参考图文件夹，现在没法上传，已有的参考图也读不到。请在服务器环境变量里设置 SOOYA_REFERENCES_DIR，重启服务后再来。
                </Callout>
              )}
              <div className="look-slots">
                {FRAMINGS.map(({ id, label, hint }) => {
                  const item = slotRef(id);
                  const state = item ? refState(item) : null;
                  return (
                    <div className="look-slot" key={id}>
                      <div className="cs-media-frame look-ref-frame">
                        <RefPreview item={item} url={item ? previews.urls[item.name] : undefined} failed={item ? previews.failed[item.name] : undefined}
                          onRetry={() => item && previews.bump(item.name)} />
                      </div>
                      <div className="look-slot-info">
                        <span className="look-slot-title">{label}</span>
                        <span className="cs-muted">{hint}</span>
                        {item && state
                          ? <span className="look-slot-meta"><Status tone={state.tone}>{state.text}</Status>{item.exists && <span className="cs-muted">{fmtBytes(item.bytes)}</span>}</span>
                          : <span className="look-slot-meta"><Status tone="off">还没有这种取景的参考图</Status></span>}
                        <div className="cs-actions">
                          <FilePick label={item ? '换一张' : '上传'} name={`上传${label}参考图`} busy={busy === `slot-${id}`} disabled={dirMissing || busy !== null}
                            onFile={(file) => void uploadSlot(id, file)} />
                          {item && (
                            <ConfirmButton label={item.exists ? '删除' : '移除记录'}
                              question={item.exists ? `删掉${label}参考图？文件也会删除。` : `文件已经不在了，移除这条记录？`}
                              confirmLabel={item.exists ? '删除这张参考图' : '移除记录'}
                              busy={busy === `delete-${item.name}`} onConfirm={() => remove(item)} />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Loadable>
      </Section>

      <Section title="所有参考图文件" desc="参考图文件夹里的全部图片。同一种取景有多张时，排在前面的优先；没在用的不会被拿去生成。">
        <Loadable state={references} label="参考图">
          {({ references: list }) => (
            <>
              {list.length === 0 ? (
                <Empty>还没有参考图。上面三个位置至少传一张正脸，她发自拍时才不会每次长得不一样。</Empty>
              ) : (
                <div className="cs-list">
                  {list.map((item) => {
                    const state = refState(item);
                    return (
                      <div className="cs-list-item look-file" key={item.name}>
                        <div className="look-file-main">
                          <div className="cs-media-frame look-file-thumb">
                            <RefPreview compact item={item} url={previews.urls[item.name]} failed={previews.failed[item.name]} onRetry={() => previews.bump(item.name)} />
                          </div>
                          <div className="look-file-text">
                            <span className="cs-list-title">{item.name}</span>
                            <span className="look-slot-meta">
                              <Tag>{FRAMING_LABEL[item.framing]}</Tag>
                              <Tag tone={state.tone}>{state.text}</Tag>
                              {item.exists && <span className="cs-list-meta">{fmtBytes(item.bytes)}</span>}
                            </span>
                          </div>
                        </div>
                        <span className="cs-list-side">
                          {item.exists && (item.configured
                            ? <Button kind="text" size="sm" busy={busy === `use-${item.name}`} onClick={() => void setUsed(item.name, false)}>停用</Button>
                            : <Button kind="quiet" size="sm" busy={busy === `use-${item.name}`} onClick={() => void setUsed(item.name, true)}>启用</Button>)}
                          <ConfirmButton label={item.exists ? '删除' : '移除记录'}
                            question={item.exists ? `删掉 ${item.name}？文件也会删除。` : `文件已经不在了，移除 ${item.name} 这条记录？`}
                            confirmLabel={item.exists ? '删除这张参考图' : '移除记录'}
                            busy={busy === `delete-${item.name}`} onConfirm={() => remove(item)} />
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="look-loose">
                <div className="cs-actions">
                  <FilePick label="上传一张参考图" busy={busy === 'upload'} disabled={dirMissing || busy !== null} onFile={(file) => void uploadLoose(file)} />
                  <Button kind="text" size="sm" busy={references.loading} onClick={() => void refreshAll()}>刷新列表</Button>
                </div>
                <p className="cs-muted">
                  按文件名判断取景：名字里带 side 或 profile 算侧脸，带 full_body 或 standing 算全身，其他都算正脸。中文文件名会被改写成下划线，想放到指定取景就用上面的三个位置。支持 PNG、JPG、WEBP、GIF。
                </p>
              </div>
            </>
          )}
        </Loadable>
      </Section>
    </Page>
  );
}
