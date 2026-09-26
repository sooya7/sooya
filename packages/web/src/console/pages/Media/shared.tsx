import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { ApiError } from '../../../lib/api.js';
import { getAdminToken } from '../../../lib/admin.js';
import { fetchAuthenticatedMedia, mediaThumbnailPath, releaseMediaUrl, safeDownloadName, type ExpectedMedia } from '../../../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../../../lib/useAuthenticatedMedia.js';
import { CostButton } from '../../ui.js';

export const KIND_LABELS: Record<string, string> = { image: '图片', audio: '语音', sticker: '表情包', file: '文件' };
export const ORIGIN_LABELS: Record<string, string> = { generated: '她生成的', remote: '聊天里收到的', upload: '上传的', builtin: '内置' };

export function kindLabel(kind: string, mime?: string): string {
  if (kind === 'file' && mime?.startsWith('video/')) return '视频';
  return KIND_LABELS[kind] ?? kind;
}

export function expectedFor(kind: string, mime?: string): ExpectedMedia {
  if (kind === 'image' || kind === 'sticker') return 'image';
  if (kind === 'audio' || mime?.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Server error codes that come without a readable message, turned into what the user can do next. */
const CODE_TEXT: Record<string, string> = {
  media_in_use: '这个文件还被聊天记录、表情包或头像用着，不能移到回收站。',
  media_is_referenced: '这个文件还被聊天记录、表情包或头像用着，不能彻底删除。',
  sticker_is_referenced: '这个表情包在聊天记录里发过，删掉会让那些消息变成裂图，所以不能删。可以把它停用。',
  manual_semantics_protected: '这个表情包的含义是手动填写的，AI 分析不会覆盖它。',
  not_found: '找不到这一项了，可能已经被删掉。刷新一下列表。',
  task_active: '任务还在进行中，先取消再删除。',
  video_not_configured: '还没有配置视频模型，先去模型页面填好接口地址、模型名和密钥。',
  file_too_large: '文件太大了，换一个小一点的。',
  expected_multipart: '没有收到文件，重新选择后再上传。'
};

export function friendly(error: unknown): unknown {
  if (error instanceof ApiError) {
    const body = error.body as { error?: string; message?: string } | undefined;
    const code = body?.error;
    if (body?.message) return error;
    if (code && CODE_TEXT[code]) return new Error(CODE_TEXT[code]);
    if (code === 'bad_request') return new Error('填写的内容不符合要求，检查一下再试。');
  }
  return error;
}

/** Wraps an API call so its failure carries a readable message. */
export async function explain<T>(action: Promise<T>): Promise<T> {
  try {
    return await action;
  } catch (error) {
    throw friendly(error);
  }
}

/* ------------------------------------------------------------ media */

export function Thumb({ path, kind, mime, alt, width = 200, fit }: {
  path: string; kind: string; mime?: string; alt: string; width?: number; fit?: 'contain';
}) {
  const visual = kind === 'image' || kind === 'sticker';
  const state = useAuthenticatedMedia(visual ? mediaThumbnailPath(path, width) : null, 'admin', 'image');
  if (!visual) return <span className="media-thumb-word">{kindLabel(kind, mime)}</span>;
  if (state.error) {
    return (
      <span className="media-thumb-word" title={state.error}>
        {state.retriable ? <button type="button" className="media-thumb-retry" onClick={(e) => { e.stopPropagation(); state.retry(); }}>重新加载</button> : '读不出来'}
      </span>
    );
  }
  if (!state.url) return <span className="media-thumb-word" aria-hidden="true" />;
  return <img src={state.url} alt={alt} loading="lazy" style={fit ? { objectFit: 'contain' } : undefined} />;
}

/** Full-size media inside the viewer. */
export function FullMedia({ path, kind, mime, alt }: { path: string; kind: string; mime?: string; alt: string }) {
  const expected = expectedFor(kind, mime);
  const state = useAuthenticatedMedia(path, 'admin', expected);
  if (state.error) {
    return (
      <div className="media-full-word">
        <span>{state.error}</span>
        {state.retriable && <button type="button" className="cs-btn" data-kind="quiet" data-size="sm" onClick={state.retry}>重新加载</button>}
      </div>
    );
  }
  if (!state.url) return <div className="media-full-word">{state.loading ? '正在读取…' : ''}</div>;
  if (expected === 'image') return <img className="media-full-img" src={state.url} alt={alt} />;
  if (expected === 'audio') return <div className="media-full-word"><audio src={state.url} controls preload="metadata" /></div>;
  if (mime?.startsWith('video/')) return <video className="media-full-img" src={state.url} controls preload="metadata" />;
  return <div className="media-full-word">这个文件不能直接预览，可以下载后查看。</div>;
}

function extension(mime: string): string {
  return mime.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') || 'bin';
}

/** Downloads the original bytes (never the thumbnail). */
export async function downloadMedia(item: { id: string; url: string; kind: string; mime: string; name?: string | null }): Promise<void> {
  const loaded = await fetchAuthenticatedMedia(item.url, { scope: 'admin', token: getAdminToken(), expected: expectedFor(item.kind, item.mime) });
  const link = document.createElement('a');
  link.href = loaded.url;
  link.download = safeDownloadName(item.name, `sooya-${item.id}.${extension(item.mime)}`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => releaseMediaUrl(loaded.url), 1500);
}

/* ------------------------------------------------------- pagination */

export interface Paged<T> {
  items: T[];
  total: number;
  extra: Record<string, unknown>;
  loading: boolean;
  error: unknown;
  hasMore: boolean;
  /** Start over from the first page (filters changed). */
  reload: () => Promise<void>;
  /** Re-read everything already on screen without losing loaded pages. */
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * Offset pagination with "load more". Responses for an outdated filter are dropped,
 * so switching filters quickly never shows the older result.
 */
export function usePaged<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ items: T[]; total: number; extra?: Record<string, unknown> }>,
  pageSize: number,
  deps: unknown[]
): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [hasMore, setHasMore] = useState(false);
  const latest = useRef(fetchPage);
  latest.current = fetchPage;
  const itemsRef = useRef<T[]>([]);
  itemsRef.current = items;
  const seq = useRef(0);

  const fetchInto = useCallback(async (offset: number, limit: number, append: boolean) => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const page = await latest.current(offset, limit);
      if (id !== seq.current) return;
      const next = append ? [...itemsRef.current, ...page.items] : page.items;
      setItems(next);
      setTotal(page.total);
      setExtra(page.extra ?? {});
      setHasMore(page.items.length === limit && next.length < page.total);
      setError(null);
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  const reload = useCallback(() => fetchInto(0, pageSize, false), [fetchInto, pageSize]);
  const refresh = useCallback(
    () => fetchInto(0, Math.min(200, Math.max(pageSize, itemsRef.current.length)), false),
    [fetchInto, pageSize]
  );
  const loadMore = useCallback(() => fetchInto(itemsRef.current.length, pageSize, true), [fetchInto, pageSize]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, deps);

  return { items, total, extra, loading, error, hasMore, reload, refresh, loadMore };
}

/** Value that settles after the user stops typing. */
export function useDebounced<T>(value: T, ms = 350): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** Selection of ids that forgets ids no longer on screen. */
export function useSelection(visibleIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const key = visibleIds.join('|');
  useEffect(() => {
    setSelected((before) => {
      const visible = new Set(visibleIds);
      const next = new Set([...before].filter((id) => visible.has(id)));
      return next.size === before.size ? before : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const toggle = useCallback((id: string) => setSelected((before) => {
    const next = new Set(before);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  return {
    selected,
    ids: [...selected],
    toggle,
    all: () => setSelected(new Set(visibleIds)),
    clear: () => setSelected(new Set())
  };
}

/** Plain-language summary of POST /api/admin/media/batch. */
export function batchSummary(verb: string, result: { changed: number; blocked?: unknown[]; missing?: unknown[]; failed?: unknown[] }): string {
  const parts = [`${verb} ${result.changed} 个`];
  if (result.blocked?.length) parts.push(`${result.blocked.length} 个还被聊天记录或头像用着，没有动`);
  if (result.missing?.length) parts.push(`${result.missing.length} 个已经不存在`);
  if (result.failed?.length) parts.push(`${result.failed.length} 个删除失败，稍后再试`);
  return parts.join('，');
}

/**
 * A button for something that calls a paid model. The first click says what it costs,
 * the second one does it. Styled as an ordinary action, not as a danger.
 */
export function PaidButton({ size = 'sm', ...props }: Omit<ComponentProps<typeof CostButton>, 'size'> & { size?: 'sm' | 'md' }) {
  return <CostButton {...props} size={size === 'sm' ? 'sm' : undefined} />;
}

