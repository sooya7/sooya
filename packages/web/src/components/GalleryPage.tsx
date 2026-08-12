import { useEffect, useMemo, useRef, useState } from 'react';
import { getAdminToken, setAdminToken } from '../lib/admin.js';
import { adminMediaUrl, featureApi, type FeatureMedia } from '../lib/features.js';
import { fetchAuthenticatedMedia, mediaThumbnailPath, releaseMediaUrl, safeDownloadName } from '../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';
import { AppLink } from './AppLink.js';
import { ImageViewer, type ViewerImage } from './ImageViewer.js';

const PAGE_SIZE = 60;
/**
 * 网格缩略图的显示宽度（CSS 像素）：网格项 `minmax(170px, 1fr)`，最宽布局下内容区
 * 约 160–180。`mediaThumbnailPath` 会乘设备像素比并向上取档（240/480/960）。
 */
const GALLERY_THUMB_CSS_WIDTH = 180;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function extension(media: FeatureMedia): string {
  return media.mime.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
}

/*
 * 保存必须拿原图：网格行的 `url` 已经是缩略图 blob，直接 fetch 它会把缩略图存下来。
 * originalPath 是加载时记下的服务端路径（不带 w）。
 */
async function downloadMedia(media: FeatureMedia, originalPath: string): Promise<void> {
  const loaded = await fetchAuthenticatedMedia(originalPath, {
    scope: 'admin',
    token: getAdminToken(),
    expected: media.kind === 'image' ? 'image' : media.kind === 'audio' ? 'audio' : 'file'
  });
  const link = document.createElement('a');
  link.href = loaded.url;
  link.download = safeDownloadName(media.name, `sooya-${media.id}.${extension(media)}`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => releaseMediaUrl(loaded.url), 1500);
}

export default function GalleryPage() {
  const objectUrls = useRef(new Set<string>());
  /** id → 服务端原图路径（行的 url 会被缩略图 blob 取代，大图与保存要靠这份路径取原图）。 */
  const originalPathById = useRef(new Map<string, string>());
  const [token, setTokenState] = useState(() => getAdminToken() ?? '');
  const [media, setMedia] = useState<FeatureMedia[]>([]);
  const mediaRef = useRef<FeatureMedia[]>([]);
  mediaRef.current = media;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [trash, setTrash] = useState(false);
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState('');
  const [favorite, setFavorite] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const hasMoreRef = useRef(false);
  useEffect(() => () => {
    for (const url of objectUrls.current) releaseMediaUrl(url);
    objectUrls.current.clear();
  }, []);

  const images = useMemo(() => media.filter((item) => item.kind === 'image' && item.exists), [media]);
  const viewerImages = useMemo<ViewerImage[]>(() => images.map((item) => ({ id: item.id, src: adminMediaUrl(item.url), alt: item.name ?? `SOOYA 图片 ${item.id}` })), [images]);
  const viewerIndex = Math.max(0, viewerImages.findIndex((item) => item.id === viewerId));
  const selectedMedia = useMemo(() => media.filter((item) => selected.has(item.id)), [media, selected]);

  /*
   * 网格里挂的是缩略图（`?w=`），大图查看器和「保存」都要原图。原图单独取一份：
   * 拿到之前查看器先显示缩略图，所以点开是即时的，清晰度随后补上。做法与
   * ImageViewerHost 一致；原图路径在加载时按 id 记下（行的 url 已被缩略图 blob 取代）。
   */
  const original = useAuthenticatedMedia(viewerId ? originalPathById.current.get(viewerId) ?? null : null, 'admin', 'image');
  const shownViewerImages = useMemo<ViewerImage[]>(
    () => (original.url ? viewerImages.map((image, at) => (at === viewerIndex ? { ...image, src: original.url as string } : image)) : viewerImages),
    [viewerImages, viewerIndex, original.url]
  );

  const query = (offset = 0) => ({ trash, search: search.trim() || undefined, origin: origin || undefined, favorite: favorite || undefined, from: from || undefined, to: to || undefined, limit: PAGE_SIZE, offset });

  /*
   * Reloads used to race: change filters while a page was still streaming in
   * and the older, slower response would setMedia([]) and republish on top of
   * the newer filter's results. Every full reload bumps a generation; anything
   * awaiting an older generation drops its result instead of publishing.
   * Appends belong to whatever generation is current.
   */
  const generation = useRef(0);

  const load = async (append = false): Promise<FeatureMedia[]> => {
    const gen = append ? generation.current : ++generation.current;
    const stale = () => gen !== generation.current;
    setLoading(true);
    setError(null);
    try {
      const base = append ? mediaRef.current : [];
      const result = await featureApi.gallery(query(append ? base.length : 0));
      if (stale()) return [];
      // The counts come from the list response and do not depend on a single byte of
      // image data, so publish them now. Holding them until every blob had
      // transferred made the header read "0 个媒体记录" for the whole download.
      setStats(result.stats ?? { count: 0, bytes: 0 });
      setTotal(result.total);
      const more = result.media.length === PAGE_SIZE;
      hasMoreRef.current = more;
      setHasMore(more);

      if (!append) {
        for (const url of objectUrls.current) releaseMediaUrl(url);
        objectUrls.current.clear();
        originalPathById.current.clear();
        mediaRef.current = [];
        setMedia([]);
      }
      // Rows land in server order as their blobs arrive instead of all at once at the
      // end: even as thumbnails a page is dozens of requests, and Promise.all kept
      // the grid empty until the last one finished. `batch` preserves the order, so
      // publishing the non-null entries never reshuffles what is already on screen.
      const batch: Array<FeatureMedia | null> = result.media.map(() => null);
      const fresh = result.media.filter((item) => !base.some((old) => old.id === item.id));
      const publish = () => {
        const rows = batch.filter((item): item is FeatureMedia => item !== null);
        const next = [...base, ...rows];
        mediaRef.current = next;
        setMedia(next);
      };
      let failed = 0;
      // allSettled, not all: one unreadable image used to reject the whole batch and
      // blank a gallery whose other items were perfectly fine.
      await Promise.all(
        fresh.map(async (item, index) => {
          try {
            originalPathById.current.set(item.id, item.url);
            let row = item;
            if (item.exists) {
              // 网格只显示缩略图：60 张原图是几十 MB，缩略图（?w= 向上取档）是一两个量级。
              const path = item.kind === 'image' ? mediaThumbnailPath(item.url, GALLERY_THUMB_CSS_WIDTH) : item.url;
              const loaded = await fetchAuthenticatedMedia(path, {
                scope: 'admin',
                token: getAdminToken(),
                expected: item.kind === 'image' ? 'image' : item.kind === 'audio' ? 'audio' : 'file'
              });
              if (stale()) {
                // A newer reload owns the grid now; this blob has no home.
                releaseMediaUrl(loaded.url);
                return;
              }
              objectUrls.current.add(loaded.url);
              row = { ...item, url: loaded.url };
            }
            if (stale()) return;
            batch[index] = row;
            publish();
          } catch {
            failed += 1;
          }
        })
      );
      if (stale()) return [];
      const next = [...base, ...batch.filter((item): item is FeatureMedia => item !== null)];
      mediaRef.current = next;
      setMedia(next);
      if (failed > 0) setError(`${failed} 张图片加载失败，其余已显示`);
      setSelected((before) => new Set([...before].filter((id) => next.some((item) => item.id === id))));
      return next;
    } catch (err) {
      if (!stale()) setError(err instanceof Error ? err.message : '图库加载失败');
      return [];
    } finally {
      // A superseded load must not clear the spinner its successor is using.
      if (!stale()) setLoading(false);
    }
  };

  useEffect(() => { if (getAdminToken()) void load(false); }, [trash, favorite]);

  const login = () => {
    if (!token.trim()) return;
    setAdminToken(token.trim());
    void load(false);
  };

  const toggle = (id: string) => setSelected((before) => {
    const next = new Set(before);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const batch = async (action: 'trash' | 'restore' | 'favorite' | 'unfavorite' | 'permanent', ids = [...selected]) => {
    if (ids.length === 0) return;
    const destructive = action === 'permanent';
    if (destructive && !window.confirm(`将永久删除 ${ids.length} 个未被引用的媒体；被引用项目会自动阻止。确认继续？`)) return;
    setLoading(true);
    try {
      const result = await featureApi.batchMedia(ids, action);
      setSelected(new Set());
      await load(false);
      if (result.blocked.length) setError(`${result.blocked.length} 个被引用媒体已阻止永久删除`);
    } catch (err) { setError(err instanceof Error ? err.message : '批量操作失败'); }
    finally { setLoading(false); }
  };

  const exportSelected = async () => {
    if (selectedMedia.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      // Browser-compatible export: download the exact selected result set one by one.
      for (const item of selectedMedia) {
        await downloadMedia(item, originalPathById.current.get(item.id) ?? item.url);
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
    } catch (err) { setError(err instanceof Error ? err.message : '导出失败'); }
    finally { setLoading(false); }
  };

  const requestNextViewerImage = async () => {
    if (!viewerId || loading) return;
    let rows = mediaRef.current;
    for (;;) {
      const loadedImages = rows.filter((item) => item.kind === 'image' && item.exists);
      const at = loadedImages.findIndex((item) => item.id === viewerId);
      if (at >= 0 && at < loadedImages.length - 1) {
        setViewerId(loadedImages[at + 1]!.id);
        return;
      }
      if (!hasMoreRef.current) return;
      const before = rows.length;
      rows = await load(true);
      if (rows.length <= before) return;
    }
  };

  if (!getAdminToken()) {
    return <main className="gallery-page gallery-gate"><section className="gallery-login"><h1>SOOYA 图库</h1><p>输入管理令牌后查看普通图库与回收站。</p><input type="password" value={token} placeholder="ADMIN_API_TOKEN" onChange={(event) => setTokenState(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') login(); }} /><button type="button" onClick={login}>进入图库</button><AppLink href="/">返回聊天</AppLink></section></main>;
  }

  return (
    <main className="gallery-page">
      <header className="gallery-header">
        <div><AppLink href="/" className="gallery-back">‹ 返回聊天</AppLink><h1>{trash ? '回收站' : '图库'}</h1><p>{stats.count} 张 · {formatBytes(stats.bytes)} · 数据库共 {total} 个媒体记录</p></div>
        <div className="gallery-header-actions"><button type="button" onClick={() => setTrash((value) => !value)}>{trash ? '返回普通图库' : '打开回收站'}</button><button type="button" onClick={() => void load(false)} disabled={loading}>刷新</button></div>
      </header>

      <section className="gallery-toolbar" aria-label="图库筛选">
        <input type="search" placeholder="文件名、媒体 ID、关联文本或标签" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void load(false); }} />
        <select value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">全部来源</option><option value="remote">收到</option><option value="upload">用户上传</option><option value="generated">机器人生成</option><option value="builtin">其他/内置</option></select>
        <label>从<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>到<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label><input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} />只看收藏</label>
        <button type="button" onClick={() => void load(false)}>应用筛选</button>
      </section>

      <section className="gallery-batchbar">
        <button type="button" onClick={() => setSelected(new Set(media.map((item) => item.id)))}>全选当前结果</button><button type="button" onClick={() => setSelected(new Set())}>取消选择</button>
        {selected.size > 0 && <><span>已选 {selected.size} 项</span>{trash ? <><button type="button" onClick={() => void batch('restore')}>批量恢复</button><button type="button" className="gallery-danger" onClick={() => void batch('permanent')}>永久删除</button></> : <><button type="button" onClick={() => void batch('favorite')}>收藏</button><button type="button" onClick={() => void batch('unfavorite')}>取消收藏</button><button type="button" onClick={() => void exportSelected()}>批量下载</button><button type="button" className="gallery-danger" onClick={() => void batch('trash')}>移入回收站</button></>}</>}
      </section>

      {error && <div className="gallery-error" role="status">{error}</div>}
      {loading && images.length === 0 && <div className="gallery-empty">正在加载图库…</div>}
      {loading && images.length > 0 && <div className="gallery-loading-more" role="status">正在加载剩余图片…</div>}
      {!loading && images.length === 0 && <div className="gallery-empty">当前筛选下没有图片</div>}

      <section className="gallery-grid">
        {images.map((item) => {
          const src = adminMediaUrl(item.url);
          const checked = selected.has(item.id);
          return <article className={`gallery-item ${checked ? 'selected' : ''}`} data-media-id={item.id} key={item.id}><button type="button" className="gallery-thumb" onClick={() => setViewerId(item.id)} aria-label="查看图片"><img src={src} alt={item.name ?? '图库图片'} loading="lazy" /></button><label className="gallery-select"><input type="checkbox" checked={checked} onChange={() => toggle(item.id)} />选择</label><div className="gallery-item-actions"><button type="button" aria-label={item.favorite ? '取消收藏' : '收藏'} onClick={() => void featureApi.patchMedia(item.id, { favorite: !item.favorite }).then(() => load(false)).catch((e) => setError(e.message))}>{item.favorite ? '★ 已收藏' : '☆ 收藏'}</button><button type="button" onClick={() => void downloadMedia(item, originalPathById.current.get(item.id) ?? item.url)}>保存</button>{trash ? <><button type="button" onClick={() => void batch('restore', [item.id])}>恢复</button><button type="button" className="gallery-danger" onClick={() => void batch('permanent', [item.id])}>永久删除</button></> : <button type="button" className="gallery-danger" onClick={() => void batch('trash', [item.id])}>移入回收站</button>}</div><small>{new Date(item.createdAt).toLocaleString()} · {formatBytes(item.bytes)} · {item.origin}</small>{item.references && item.references.total > 0 && <small>被引用 {item.references.total} 次</small>}</article>;
        })}
      </section>

      {hasMore && <div className="gallery-empty"><button type="button" disabled={loading} onClick={() => void load(true)}>加载更多</button></div>}
      {viewerId && viewerImages.length > 0 && <ImageViewer
        images={shownViewerImages}
        index={viewerIndex}
        onIndexChange={(index) => setViewerId(viewerImages[index]?.id ?? viewerId)}
        onRequestNext={hasMore ? requestNextViewerImage : undefined}
        navigationBusy={loading}
        countLabel={`${viewerIndex + 1} / ${viewerImages.length}${hasMore ? '+' : ''}`}
        onClose={() => setViewerId(null)}
      />}
    </main>
  );
}