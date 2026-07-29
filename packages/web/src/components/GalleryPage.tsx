import { useEffect, useMemo, useState } from 'react';
import { adminApi, getAdminToken, setAdminToken, type AdminMedia } from '../lib/admin.js';
import { ImageViewer, type ViewerImage } from './ImageViewer.js';

function adminMediaUrl(url: string): string {
  const token = getAdminToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}admin_token=${encodeURIComponent(token)}`;
}

async function saveMedia(media: AdminMedia): Promise<void> {
  const src = adminMediaUrl(media.url);
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `sooya-${media.id}.${media.mime.split('/')[1] || 'jpg'}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch {
    window.open(src, '_blank', 'noopener,noreferrer');
  }
}

export default function GalleryPage() {
  const [token, setTokenState] = useState(() => getAdminToken() ?? '');
  const [media, setMedia] = useState<AdminMedia[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const images = useMemo(() => media.filter((item) => item.kind === 'image' && item.exists), [media]);
  const viewerImages = useMemo<ViewerImage[]>(
    () => images.map((item) => ({ id: item.id, src: adminMediaUrl(item.url), alt: `SOOYA 图片 ${item.id}` })),
    [images]
  );
  const viewerIndex = Math.max(0, viewerImages.findIndex((item) => item.id === viewerId));

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await adminApi.media();
      setMedia(result.media);
      setSelected((before) => new Set([...before].filter((id) => result.media.some((item) => item.id === id))));
    } catch (err) {
      setError(err instanceof Error ? err.message : '图库加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (getAdminToken()) void load();
  }, []);

  const login = () => {
    if (!token.trim()) return;
    setAdminToken(token.trim());
    void load();
  };

  const toggle = (id: string) => {
    setSelected((before) => {
      const next = new Set(before);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const remove = async (ids: string[]) => {
    if (ids.length === 0) return;
    const warning = ids.length === 1
      ? '确认删除这张图片？聊天记录中的原图也会变为不可用。'
      : `确认删除选中的 ${ids.length} 张图片？聊天记录中的原图也会变为不可用。`;
    if (!window.confirm(warning)) return;
    setLoading(true);
    try {
      for (const id of ids) await adminApi.deleteMedia(id);
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setLoading(false);
    }
  };

  if (!getAdminToken()) {
    return (
      <main className="gallery-page gallery-gate">
        <section className="gallery-login">
          <h1>SOOYA 图库</h1>
          <p>输入管理令牌后查看和管理聊天图片。</p>
          <input type="password" value={token} placeholder="ADMIN_API_TOKEN" onChange={(event) => setTokenState(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') login(); }} />
          <button type="button" onClick={login}>进入图库</button>
          <a href="/">返回聊天</a>
        </section>
      </main>
    );
  }

  return (
    <main className="gallery-page">
      <header className="gallery-header">
        <div>
          <a href="/" className="gallery-back">‹ 返回聊天</a>
          <h1>图库</h1>
          <p>收到、上传和生成的图片都会集中显示在这里。</p>
        </div>
        <div className="gallery-header-actions">
          <button type="button" onClick={() => void load()} disabled={loading}>刷新</button>
          {selected.size > 0 && <button type="button" className="gallery-danger" onClick={() => void remove([...selected])}>删除所选（{selected.size}）</button>}
        </div>
      </header>

      {error && <div className="gallery-error">{error}</div>}
      {loading && images.length === 0 && <div className="gallery-empty">正在加载图库…</div>}
      {!loading && images.length === 0 && <div className="gallery-empty">图库里还没有图片</div>}

      <section className="gallery-grid">
        {images.map((item) => {
          const src = adminMediaUrl(item.url);
          const checked = selected.has(item.id);
          return (
            <article className={`gallery-item ${checked ? 'selected' : ''}`} key={item.id}>
              <button type="button" className="gallery-thumb" onClick={() => setViewerId(item.id)} aria-label="查看图片">
                <img src={src} alt="图库图片" loading="lazy" />
              </button>
              <label className="gallery-select">
                <input type="checkbox" checked={checked} onChange={() => toggle(item.id)} />
                选择
              </label>
              <div className="gallery-item-actions">
                <button type="button" onClick={() => void saveMedia(item)}>保存</button>
                <button type="button" className="gallery-danger" onClick={() => void remove([item.id])}>删除</button>
              </div>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
            </article>
          );
        })}
      </section>

      {viewerId && viewerImages.length > 0 && (
        <ImageViewer
          images={viewerImages}
          index={viewerIndex}
          onIndexChange={(index) => setViewerId(viewerImages[index]?.id ?? viewerId)}
          onClose={() => setViewerId(null)}
        />
      )}
    </main>
  );
}
