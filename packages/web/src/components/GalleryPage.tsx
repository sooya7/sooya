import { useEffect, useMemo, useRef, useState } from 'react';
import { getAdminToken, setAdminToken } from '../lib/admin.js';
import { adminMediaUrl, featureApi, type FeatureMedia } from '../lib/features.js';
import { fetchAuthenticatedMedia, releaseMediaUrl, safeDownloadName } from '../lib/authenticatedMedia.js';
import { ImageViewer, type ViewerImage } from './ImageViewer.js';

const PAGE_SIZE = 60;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function extension(media: FeatureMedia): string {
  return media.mime.split('/')[1]?.replace('jpeg', 'jpg') || 'bin';
}

async function downloadMedia(media: FeatureMedia): Promise<void> {
  const src = adminMediaUrl(media.url);
  const response = await fetch(src);
  if (!response.ok) throw new Error(`媒体下载失败（${response.status}）`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = safeDownloadName(media.name, `sooya-${media.id}.${extension(media)}`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

export default function GalleryPage() {
  const objectUrls = useRef(new Set<string>());
  const [token, setTokenState] = useState(() => getAdminToken() ?? '');
  const [media, setMedia] = useState<FeatureMedia[]>([]);
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
  useEffect(() => () => {
    for (const url of objectUrls.current) releaseMediaUrl(url);
    objectUrls.current.clear();
  }, []);

  const images = useMemo(() => media.filter((item) => item.kind === 'image' && item.exists), [media]);
  const viewerImages = useMemo<ViewerImage[]>(() => images.map((item) => ({ id: item.id, src: adminMediaUrl(item.url), alt: item.name ?? `SOOYA 图片 ${item.id}` })), [images]);
  const viewerIndex = Math.max(0, viewerImages.findIndex((item) => item.id === viewerId));
  const selectedMedia = useMemo(() => media.filter((item) => selected.has(item.id)), [media, selected]);

  const query = (offset = 0) => ({ trash, search: search.trim() || undefined, origin: origin || undefined, favorite: favorite || undefined, from: from || undefined, to: to || undefined, limit: PAGE_SIZE, offset });

  const load = async (append = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await featureApi.gallery(query(append ? media.length : 0));
      // The counts come from the list response and do not depend on a single byte of
      // image data, so publish them now. Holding them until every blob had
      // transferred made the header read "0 个媒体记录" for the whole download.
      setStats(result.stats ?? { count: 0, bytes: 0 });
      setTotal(result.total);
      setHasMore(result.media.length === PAGE_SIZE);

      const base = append ? media : [];
      if (!append) {
        for (const url of objectUrls.current) releaseMediaUrl(url);
        objectUrls.current.clear();
        setMedia([]);
      }
      // Rows land in server order as their blobs arrive instead of all at once at the
      // end: a page of full-size originals is tens of megabytes, and Promise.all kept
      // the grid empty until the last one finished. `batch` preserves the order, so
      // publishing the non-null entries never reshuffles what is already on screen.
      const batch: Array<FeatureMedia | null> = result.media.map(() => null);
      const fresh = result.media.filter((item) => !base.some((old) => old.id === item.id));
      const publish = () => {
        const rows = batch.filter((item): item is FeatureMedia => item !== null);
        setMedia([...base, ...rows]);
      };
      let failed = 0;
      // allSettled, not all: one unreadable image used to reject the whole batch and
      // blank a gallery whose other items were perfectly fine.
      await Promise.all(
        fresh.map(async (item, index) => {
          try {
            let row = item;
            if (item.exists) {
              const loaded = await fetchAuthenticatedMedia(item.url, {
                scope: 'admin',
                token: getAdminToken(),
                expected: item.kind === 'image' ? 'image' : item.kind === 'audio' ? 'audio' : 'file'
              });
              objectUrls.current.add(loaded.url);
              row = { ...item, url: loaded.url };
            }
            batch[index] = row;
            publish();
          } catch {
            failed += 1;
          }
        })
      );
      const next = [...base, ...batch.filter((item): item is FeatureMedia => item !== null)];
      if (failed > 0) setError(`${failed} 张图片加载失败，其余已显示`);
      setSelected((before) => new Set([...before].filter((id) => next.some((item) => item.id === id))));
    } catch (err) {
      setError(err instanceof Error ? err.message : '图库加载失败');
    } finally {
      setLoading(false);
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
        await downloadMedia(item);
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
    } catch (err) { setError(err instanceof Error ? err.message : '导出失败'); }
    finally { setLoading(false); }
  };

  if (!getAdminToken()) {
    return <main className="gallery-page gallery-gate"><section className="gallery-login"><h1>SOOYA 图库</h1><p>输入管理令牌后查看普通图库与回收站。</p><input type="password" value={token} placeholder="ADMIN_API_TOKEN" onChange={(event) => setTokenState(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') login(); }} /><button type="button" onClick={login}>进入图库</button><a href="/">返回聊天</a></section></main>;
  }

  return (
    <main className="gallery-page">
      <header className="gallery-header">
        <div><a href="/admin/features" className="gallery-back">‹ 返回功能中心</a><h1>{trash ? '回收站' : '图库'}</h1><p>{stats.count} 张 · {formatBytes(stats.bytes)} · 数据库共 {total} 个媒体记录</p></div>
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
          return <article className={`gallery-item ${checked ? 'selected' : ''}`} data-media-id={item.id} key={item.id}><button type="button" className="gallery-thumb" onClick={() => setViewerId(item.id)} aria-label="查看图片"><img src={src} alt={item.name ?? '图库图片'} loading="lazy" /></button><label className="gallery-select"><input type="checkbox" checked={checked} onChange={() => toggle(item.id)} />选择</label><div className="gallery-item-actions"><button type="button" aria-label={item.favorite ? '取消收藏' : '收藏'} onClick={() => void featureApi.patchMedia(item.id, { favorite: !item.favorite }).then(() => load(false)).catch((e) => setError(e.message))}>{item.favorite ? '★ 已收藏' : '☆ 收藏'}</button><button type="button" onClick={() => void downloadMedia(item)}>保存</button>{trash ? <><button type="button" onClick={() => void batch('restore', [item.id])}>恢复</button><button type="button" className="gallery-danger" onClick={() => void batch('permanent', [item.id])}>永久删除</button></> : <button type="button" className="gallery-danger" onClick={() => void batch('trash', [item.id])}>移入回收站</button>}</div><small>{new Date(item.createdAt).toLocaleString()} · {formatBytes(item.bytes)} · {item.origin}</small>{item.references && item.references.total > 0 && <small>被引用 {item.references.total} 次</small>}</article>;
        })}
      </section>

      {hasMore && <div className="gallery-empty"><button type="button" disabled={loading} onClick={() => void load(true)}>加载更多</button></div>}
      {viewerId && viewerImages.length > 0 && <ImageViewer images={viewerImages} index={viewerIndex} onIndexChange={(index) => setViewerId(viewerImages[index]?.id ?? viewerId)} onClose={() => setViewerId(null)} />}
    </main>
  );
}
