import { useCallback, useEffect, useState } from 'react';
import { api, type ConversationInfo, type Moment } from '../lib/api.js';
import { mediaThumbnailPath } from '../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';
import { weatherConditionLabel } from '../lib/worldDisplay.js';
import { AppLink } from './AppLink.js';

const MOMENT_IMAGE_CSS_WIDTH = 560;

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function MomentPhoto({ moment }: { moment: Moment }) {
  const image = moment.image;
  const media = useAuthenticatedMedia(image ? mediaThumbnailPath(image.url, MOMENT_IMAGE_CSS_WIDTH) : null, 'user', 'image');
  if (!image) return null;
  if (media.error) return <div className="moment-photo-error">图片暂时加载失败{media.retriable && <button type="button" onClick={media.retry}>重试</button>}</div>;
  if (!media.url) return <div className="moment-photo-skeleton" aria-label="正在加载图片" />;
  return (
    <button
      type="button"
      className="moment-photo image-part"
      data-media-id={image.id}
      data-src={media.url}
      data-alt={moment.text}
      onClick={() => window.dispatchEvent(new CustomEvent('sooya:open-image', { detail: { id: image.id } }))}
      aria-label="查看动态图片"
    >
      <img src={media.url} alt={moment.text} />
    </button>
  );
}

export default function MomentsPage() {
  const [conversation, setConversation] = useState<ConversationInfo | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const avatarPath = conversation?.persona.avatar ? mediaThumbnailPath(conversation.persona.avatar, 96) : null;
  const avatar = useAuthenticatedMedia(avatarPath, 'user', 'image');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [nextConversation, nextMoments] = await Promise.all([api.conversation(), api.moments(60)]);
      setConversation(nextConversation);
      setMoments(nextMoments.moments);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '动态加载失败');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const setLiked = async (moment: Moment) => {
    const liked = !moment.liked;
    setMoments((rows) => rows.map((row) => row.id === moment.id ? { ...row, liked } : row));
    try {
      const result = await api.likeMoment(moment.id, liked);
      setMoments((rows) => rows.map((row) => row.id === moment.id ? result.moment : row));
    } catch (cause) {
      setMoments((rows) => rows.map((row) => row.id === moment.id ? { ...row, liked: moment.liked } : row));
      setError(cause instanceof Error ? cause.message : '点赞失败');
    }
  };

  const personaName = conversation?.persona.name ?? 'SOOYA';
  const personaAvatar = avatar.url ?? '/avatars/sooya.svg';

  return (
    <main className="moments-page">
      <header className="moments-topbar">
        <AppLink href="/" className="moments-back" aria-label="返回聊天">‹</AppLink>
        <div><h1>动态</h1><span>{personaName} 的生活动态</span></div>
        <button type="button" className="moments-refresh" onClick={() => void load()} aria-label="刷新动态">↻</button>
      </header>

      <section className="moments-feed" aria-busy={loading}>
        {error && <div className="moments-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>}
        {loading && moments.length === 0 && <div className="moments-loading"><span /><span /><span /></div>}
        {!loading && moments.length === 0 && !error && (
          <div className="moments-empty">
            <img src={personaAvatar} alt="" />
            <strong>这里还很安静</strong>
            <p>{personaName} 经历到值得记录的小事后，会自己发在这里。</p>
          </div>
        )}
        {moments.map((moment) => {
          const place = [moment.location?.city, moment.location?.name].filter(Boolean).join(' · ');
          const weather = moment.weather
            ? `${weatherConditionLabel(moment.weather.condition)}${moment.weather.temperatureC == null ? '' : ` · ${Math.round(moment.weather.temperatureC)}°C`}`
            : '';
          return (
            <article className="moment-card" key={moment.id} data-testid="moment-card">
              <img className="moment-avatar" src={personaAvatar} alt="" />
              <div className="moment-body">
                <div className="moment-author"><strong>{personaName}</strong><span>{moment.activity}</span></div>
                <p className="moment-text">{moment.text}</p>
                <MomentPhoto moment={moment} />
                {(place || weather) && <div className="moment-context">{place && <span>⌖ {place}</span>}{weather && <span>{weather}</span>}</div>}
                <div className="moment-footer">
                  <time dateTime={moment.createdAt}>{relativeTime(moment.createdAt)}</time>
                  <button type="button" className={`moment-like${moment.liked ? ' is-liked' : ''}`} aria-pressed={moment.liked} onClick={() => void setLiked(moment)}>
                    <span aria-hidden="true">{moment.liked ? '♥' : '♡'}</span>{moment.liked ? '已喜欢' : '喜欢'}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
