import { useEffect, useState } from 'react';
import { adminApi } from '../../../lib/admin.js';
import { featureApi } from '../../../lib/features.js';
import { consolePath } from '../../routes.js';
import {
  Button, Callout, ConfirmButton, Facts, Field, Input, Loadable, Tag, fmtAgo, fmtBytes, fmtTime, useAction, useConsole, useLoad
} from '../../ui.js';
import { Layer } from './Layer.js';
import { FullMedia, ORIGIN_LABELS, downloadMedia, explain, kindLabel } from './shared.js';

const REFERENCE_LABELS: Array<[string, string]> = [
  ['messageParts', '聊天消息'],
  ['stickers', '表情包'],
  ['moments', '她的动态'],
  ['voiceGenerations', '语音合成记录']
];

type MediaExtras = { width?: number | null; height?: number | null; duration?: number | null; transcript?: string | null };

function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,，、\s]+/u).map((tag) => tag.trim()).filter(Boolean))].slice(0, 30);
}

function duration(seconds: unknown): string | null {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = Math.round(n);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** Things worth showing from the stored metadata, in words; the rest stays in the raw view. */
function metaFacts(meta: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const text = (key: string) => (typeof meta[key] === 'string' && (meta[key] as string).trim() ? (meta[key] as string).trim() : null);
  const prompt = text('prompt') ?? text('revisedPrompt');
  if (prompt) out.push(['生成时的描述', prompt]);
  const filename = text('filename') ?? text('originalName');
  if (filename) out.push(['原文件名', filename]);
  if (meta.videoSource) out.push(['用途', '视频生成的参考图']);
  return out;
}

export function MediaViewer({ id, position, onClose, onPrev, onNext, onChanged }: {
  id: string;
  position?: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  /** Something about this item changed; re-read the list behind the layer. */
  onChanged: (removed?: boolean) => void;
}) {
  const { markClean, navigate } = useConsole();
  const { run, busy } = useAction();
  const info = useLoad(async () => {
    const [detail, usage] = await Promise.all([adminApi.mediaDetail(id), adminApi.mediaUsage(id)]);
    return { media: detail.media, usage };
  }, [id]);
  const [tagsDraft, setTagsDraft] = useState('');
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const savedTags = (info.data?.media.tags ?? []).join('，');
  useEffect(() => { setTagsDraft(savedTags); setLeaving(null); }, [id, savedTags]);
  const tagsChanged = info.data !== null && parseTags(tagsDraft).join('，') !== parseTags(savedTags).join('，');

  // Leaving with unsaved tags asks first instead of silently dropping them.
  const guard = (go: () => void) => () => { if (tagsChanged) setLeaving(() => go); else { markClean(); go(); } };
  const discardAndGo = (go: () => void) => { markClean(); setLeaving(null); go(); };

  const media = info.data?.media;
  const title = media ? (media.name || `${kindLabel(media.kind, media.mime)} ${media.id.slice(-8)}`) : '正在读取';

  const saveTags = () => run('tags', async () => {
    const result = await explain(featureApi.patchMedia(id, { tags: parseTags(tagsDraft) }));
    info.setData((old) => (old ? { ...old, media: { ...old.media, tags: result.media.tags } } : old));
    markClean();
    onChanged();
    return true;
  }, '标签已保存');

  const setFavorite = (favorite: boolean) => run('favorite', async () => {
    await explain(featureApi.patchMedia(id, { favorite }));
    info.setData((old) => (old ? { ...old, media: { ...old.media, favorite } } : old));
    onChanged();
  }, favorite ? '已收藏' : '已取消收藏');

  const trash = () => run('trash', async () => {
    await explain(featureApi.trashMedia(id));
    markClean();
    onChanged(true);
  }, '已移到回收站');

  const restore = () => run('restore', async () => {
    await explain(featureApi.restoreMedia(id));
    onChanged(true);
  }, '已从回收站恢复');

  const destroy = () => run('destroy', async () => {
    await explain(featureApi.deleteMedia(id));
    onChanged(true);
  }, '已彻底删除');

  return (
    <Layer
      title={title}
      position={position}
      onClose={guard(onClose)}
      onPrev={onPrev ? guard(onPrev) : undefined}
      onNext={onNext ? guard(onNext) : undefined}
      media={media ? <FullMedia path={media.url} kind={media.kind} mime={media.mime} alt={title} /> : null}
    >
      {leaving && (
        <Callout tone="warn">
          标签改了还没保存。{' '}
          <span className="cs-actions" style={{ display: 'inline-flex' }}>
            <Button size="sm" busy={busy === 'tags'} onClick={() => void saveTags().then((ok) => { if (!ok) return; const go = leaving; setLeaving(null); go(); })}>保存标签</Button>
            <Button kind="text" size="sm" onClick={() => discardAndGo(leaving)}>不保存</Button>
            <Button kind="text" size="sm" onClick={() => setLeaving(null)}>继续编辑</Button>
          </span>
        </Callout>
      )}
      <Loadable state={info} label="这个文件的信息">
        {({ media: record, usage }) => {
          const item = record as typeof record & MediaExtras;
          const trashed = Boolean(item.deletedAt);
          const inUse = usage.usageCount > 0 || usage.avatar;
          const refs = REFERENCE_LABELS.filter(([key]) => Number(usage.references[key] ?? 0) > 0);
          const extra = metaFacts(item.meta ?? {});
          const size = item.width && item.height ? `${item.width} × ${item.height}` : null;
          return (
            <>
              {!item.exists && <Callout tone="bad">文件本身已经找不到了（可能被手动删掉或存储出错），这里只剩记录。</Callout>}
              {trashed && <Callout tone="warn">在回收站里，{fmtAgo(item.deletedAt)}移进来的。</Callout>}
              <Facts items={[
                ['类型', kindLabel(item.kind, item.mime)],
                ['来源', ORIGIN_LABELS[item.origin] ?? item.origin],
                ['大小', fmtBytes(item.bytes)],
                ...(size ? [['尺寸', size] as [string, string]] : []),
                ...(duration(item.duration) ? [['时长', duration(item.duration)!] as [string, string]] : []),
                ['时间', fmtTime(item.createdAt, true)]
              ]} />
              {item.transcript && (
                <div className="media-side-block">
                  <span className="cs-field-label">这段语音说的是</span>
                  <p className="cs-her-quote">{item.transcript}</p>
                </div>
              )}
              {extra.length > 0 && <Facts items={extra} />}

              <div className="media-side-block">
                <span className="cs-field-label">被用在哪里</span>
                {inUse ? (
                  <ul className="media-usage">
                    {refs.map(([key, label]) => <li key={key}>{label} {Number(usage.references[key])} 处</li>)}
                    {usage.avatar && <li>正在用作头像</li>}
                  </ul>
                ) : <p className="cs-muted">没有被任何消息、表情包或头像用到。</p>}
                {Number(usage.references.messageParts ?? 0) > 0 && (
                  <Button kind="text" size="sm" onClick={guard(() => navigate(consolePath('chats')))}>去聊天记录里找</Button>
                )}
                {inUse && <p className="cs-muted">被用到的文件不能移到回收站或删除，免得聊天记录里出现裂图。</p>}
              </div>

              {!trashed && (
                <div className="media-side-block">
                  <Field label="标签" hint="用逗号或空格隔开，方便以后搜到。">
                    <Input value={tagsDraft} placeholder="例如：海边，自拍" onChange={(e) => setTagsDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && tagsChanged) void saveTags(); }} />
                  </Field>
                  {item.tags.length > 0 && !tagsChanged && <span className="cs-actions">{item.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</span>}
                </div>
              )}

              <div className="cs-actions">
                {!trashed && tagsChanged && <Button size="sm" busy={busy === 'tags'} onClick={() => void saveTags()}>保存标签</Button>}
                {!trashed && (
                  <Button kind="quiet" size="sm" busy={busy === 'favorite'} onClick={() => void setFavorite(!item.favorite)}>
                    {item.favorite ? '取消收藏' : '收藏'}
                  </Button>
                )}
                {item.exists && <Button kind="quiet" size="sm" busy={busy === 'download'} onClick={() => void run('download', () => downloadMedia(item))}>下载原文件</Button>}
              </div>
              <div className="cs-actions">
                {trashed ? (
                  <>
                    <ConfirmButton label="恢复" question="放回相册？" confirmLabel="恢复" busy={busy === 'restore'} onConfirm={restore} />
                    <ConfirmButton label="彻底删除" question="文件会从硬盘上删掉，不能找回。确定？" confirmLabel="彻底删除" busy={busy === 'destroy'} disabled={inUse} onConfirm={destroy} />
                  </>
                ) : (
                  <ConfirmButton label="移到回收站" question="移到回收站？之后还能恢复。" confirmLabel="移到回收站" busy={busy === 'trash'} disabled={inUse} onConfirm={trash} />
                )}
              </div>

              {Object.keys(item.meta ?? {}).length > 0 && (
                <details className="media-raw">
                  <summary className="cs-muted">原始记录</summary>
                  <pre className="cs-code">{JSON.stringify({ id: item.id, mime: item.mime, ...item.meta }, null, 2)}</pre>
                </details>
              )}
            </>
          );
        }}
      </Loadable>
    </Layer>
  );
}
