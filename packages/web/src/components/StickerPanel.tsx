import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { mediaThumbnailPath } from '../lib/authenticatedMedia.js';
import type { StickerInfo } from '../lib/types.js';
import { AuthenticatedImage } from './AuthenticatedMedia.js';

type StickerScope = 'recent' | 'favorite' | 'all';

interface Props {
  stickers: StickerInfo[];
  onSelect: (sticker: StickerInfo) => void;
  onNotice?: (text: string) => void;
}

const SCOPE_LABELS: Array<{ id: StickerScope; label: string }> = [
  { id: 'recent', label: '最近' },
  { id: 'favorite', label: '收藏' },
  { id: 'all', label: '全部' }
];

function byRecent(a: StickerInfo, b: StickerInfo): number {
  return (b.userLastUsedAt ?? '').localeCompare(a.userLastUsedAt ?? '');
}

/** The chat picker stays small and fast, while search and user scopes are API-backed. */
export function StickerPanel({ stickers, onSelect, onNotice }: Props) {
  const [scope, setScope] = useState<StickerScope>('all');
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<StickerInfo[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [favoriteBusy, setFavoriteBusy] = useState<Set<string>>(new Set());

  useEffect(() => {
    // The bootstrap already contains the complete small catalogue. Avoid a
    // second request when the panel first opens, which also keeps offline chat
    // usable; scoped/search views fetch their authoritative page.
    if (scope === 'all' && !query.trim() && stickers.length < 60) {
      setRemote(null);
      setNextCursor(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNextCursor(null);
    void api.stickerSearch({ scope, q: query, limit: 60 }).then((result) => {
      if (!cancelled) {
        setRemote(result.stickers);
        setNextCursor(result.nextCursor);
      }
    }).catch((error) => {
      if (!cancelled) {
        setRemote(null);
        onNotice?.(error instanceof Error ? `表情包搜索失败：${error.message}` : '表情包搜索失败');
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [onNotice, query, scope, stickers.length]);

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const result = await api.stickerSearch({ scope, q: query, limit: 60, cursor: nextCursor });
      setRemote((previous) => [...(previous ?? stickers), ...result.stickers]);
      setNextCursor(result.nextCursor);
    } catch (error) {
      onNotice?.(error instanceof Error ? `表情包加载失败：${error.message}` : '表情包加载失败');
    } finally {
      setLoading(false);
    }
  };

  const visible = useMemo(() => {
    const source = remote ?? stickers;
    const filtered = source.filter((sticker) => scope !== 'favorite' || sticker.favorite);
    const sorted = scope === 'recent' ? [...filtered].sort(byRecent) : filtered;
    if (!query.trim() || remote) return sorted;
    const needle = query.trim().toLocaleLowerCase();
    return sorted.filter((sticker) => [sticker.name, sticker.description, sticker.imageText, sticker.emotion, ...sticker.tags]
      .filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(needle)));
  }, [query, remote, scope, stickers]);

  const toggleFavorite = async (event: { stopPropagation: () => void }, sticker: StickerInfo) => {
    event.stopPropagation();
    if (favoriteBusy.has(sticker.id)) return;
    const next = !(sticker.favorite ?? false);
    setFavoriteBusy((previous) => new Set(previous).add(sticker.id));
    try {
      const result = await api.stickerPreference(sticker.id, next);
      // Keep the bootstrap list in sync for the duration of this panel. The
      // parent will receive the updated list on its next bootstrap/event sync.
      setRemote((previous) => (previous ?? stickers).map((item) => item.id === sticker.id ? result.sticker : item));
    } catch (error) {
      onNotice?.(error instanceof Error ? `收藏失败：${error.message}` : '收藏失败');
    } finally {
      setFavoriteBusy((previous) => {
        const nextBusy = new Set(previous);
        nextBusy.delete(sticker.id);
        return nextBusy;
      });
    }
  };

  return (
    <div className="sticker-panel" data-testid="sticker-panel">
      <div className="sticker-panel-toolbar">
        <div className="sticker-tabs" role="tablist" aria-label="表情包范围">
          {SCOPE_LABELS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={scope === item.id}
              className={scope === item.id ? 'sticker-tab active' : 'sticker-tab'}
              onClick={() => { setScope(item.id); setRemote(null); setNextCursor(null); }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <input
          className="sticker-search"
          data-testid="sticker-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索表情…"
          aria-label="搜索表情包"
        />
      </div>
      {loading && <div className="sticker-loading" role="status">正在读取…</div>}
      {!loading && visible.length === 0 && <div className="sticker-empty">还没有可用的表情包</div>}
      <div className="sticker-grid">
        {visible.map((sticker) => (
          <div
            key={sticker.id}
            className="sticker-choice"
            onClick={() => onSelect(sticker)}
            title={sticker.description || sticker.emotion || sticker.name}
          >
            <button type="button" className="sticker-choice-main" onClick={(event) => { event.stopPropagation(); onSelect(sticker); }}>
              <AuthenticatedImage path={sticker.animated ? sticker.url : mediaThumbnailPath(sticker.url, 96)} scope="user" alt={sticker.name} loading="lazy" />
              <span className="sticker-choice-name">{sticker.name}</span>
            </button>
            <button
              type="button"
              className={sticker.favorite ? 'sticker-favorite active' : 'sticker-favorite'}
              aria-label={sticker.favorite ? `取消收藏${sticker.name}` : `收藏${sticker.name}`}
              onClick={(event) => void toggleFavorite(event, sticker)}
            >
              {sticker.favorite ? '★' : '☆'}
            </button>
          </div>
        ))}
      </div>
      {nextCursor && <button type="button" className="sticker-load-more" disabled={loading} onClick={() => void loadMore()}>{loading ? '正在读取…' : '加载更多'}</button>}
    </div>
  );
}
