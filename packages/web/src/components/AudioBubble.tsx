import { useEffect, useRef, useState } from 'react';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';
import type { MessagePart } from '../lib/types.js';

/** Deterministic bar heights in 0.25..1 from a media id. */
function waveform(seed: string, count: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h ^ seed.charCodeAt(i)) * 16777619;
  }
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    h = (h ^ (h >>> 13)) * 1274126177;
    out.push(0.25 + (Math.abs(h >>> 8) % 1000) / 1000 * 0.75);
  }
  return out;
}

const SPEEDS = [1, 1.5, 2];

/** Bar geometry, mirrored from `.audio-wave i` / `.audio-wave` gap in styles.css. */
export const BAR_W = 2;
export const BAR_GAP = 2;
/**
 * Everything in the bubble that is not the waveform: 12px padding twice, the 30px play
 * button, three 8px flex gaps, `.audio-time` (32px) and `.audio-speed` (30px).
 */
export const BUBBLE_CHROME_W = 24 + 30 + 24 + 32 + 30;

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface Props {
  part: MessagePart;
  mine: boolean;
}

export function AudioBubble({ part, mine }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const media = useAuthenticatedMedia(part.media?.url, 'user', 'audio');

  // Prefer the server-measured duration; fall back to the element's own value.
  const [elementDuration, setElementDuration] = useState<number | null>(null);
  const duration = part.duration ?? part.media?.duration ?? elementDuration ?? 0;
  const transcript = part.transcript ?? part.media?.transcript ?? null;

  const src = media.url ?? '';

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Also keyed on src: loading a new source resets playbackRate to 1, so a user
    // who picked 2x would silently drop back to normal speed.
    audio.playbackRate = SPEEDS[speedIdx] ?? 1;
  }, [speedIdx, src]);

  // A retry (or a newly arrived url) must clear a previous failure, otherwise the
  // bubble stays stuck on "音频加载失败" forever.
  useEffect(() => { setLoadError(false); }, [src]);

  if (part.status === 'failed') {
    return (
      <div className={`bubble bubble-audio failed ${mine ? 'mine' : 'theirs'}`}>
        <span className="failed-text">语音发送失败{part.error ? `：${part.error}` : ''}</span>
      </div>
    );
  }

  if (!part.media) {
    return (
      <div className={`bubble bubble-audio pending ${mine ? 'mine' : 'theirs'}`}>
        <span className="failed-text">语音生成中…</span>
      </div>
    );
  }

  // A stable pseudo-waveform: derived from the media id so the same voice note
  // always looks the same, without decoding audio just to draw 24 bars.
  const bars = waveform(part.media.id, Math.max(14, Math.min(28, Math.round(duration * 1.6) || 18)));
  const progress = duration > 0 ? Math.min(current / duration, 1) : 0;
  // Width scales with length, like a familiar messenger voice bubble -- but it is the
  // width of the whole bubble, so the fixed furniture has to be paid for first. The old
  // formula (70 + duration * 3.2) ignored it and returned 110px for a 12s clip, which is
  // less than the furniture alone: the waveform was left negative space, overflowed its
  // track and rendered on top of the duration. Keep BUBBLE_CHROME_W in step with the
  // padding, play button, gaps, `.audio-time` and `.audio-speed` in styles.css.
  const width = Math.min(BUBBLE_CHROME_W + bars.length * (BAR_W + BAR_GAP) - BAR_GAP, 300);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play().catch(() => setLoadError(true));
    }
  };

  const seek = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || duration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clientX = 'touches' in e ? (e.touches[0]?.clientX ?? 0) : e.clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrent(audio.currentTime);
  };

  const mode = part.meta?.voiceMode as string | undefined;
  return (
    <div className="audio-wrap">
      {mode === 'summary' && <span className="voice-mode-label" data-testid="voice-mode-summary">语音摘要</span>}
      {mode === 'replace' && <span className="voice-mode-label">语音</span>}
      <div className={`bubble bubble-audio ${mine ? 'mine' : 'theirs'}`} style={{ width }}>
        <button
          type="button"
          className="audio-play"
          onClick={toggle}
          disabled={!src}
          aria-label={playing ? '暂停语音' : '播放语音'}
          data-testid="audio-play"
        >
          {playing ? (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
              <rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M8 5.5v13l11-6.5-11-6.5z" fill="currentColor" />
            </svg>
          )}
        </button>

        <div
          className="audio-track"
          onClick={seek}
          role="slider"
          tabIndex={0}
          aria-label="语音进度"
          aria-valuemin={0}
          aria-valuemax={Math.max(1, Math.round(duration))}
          aria-valuenow={Math.round(current)}
          onKeyDown={(e) => {
            const audio = audioRef.current;
            if (!audio) return;
            if (e.key === 'ArrowRight') audio.currentTime = Math.min(duration, audio.currentTime + 3);
            if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 3);
          }}
        >
          <div className="audio-wave" aria-hidden="true">
            {bars.map((height, i) => (
              <i
                key={i}
                className={(i + 1) / bars.length <= progress ? 'played' : ''}
                style={{ height: `${Math.round(height * 100)}%` }}
              />
            ))}
          </div>
        </div>

        <span className="audio-time" data-testid="audio-duration">
          {formatTime(playing || current > 0 ? current : duration)}
        </span>

        <button
          type="button"
          className="audio-speed"
          onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
          aria-label="切换播放速度"
        >
          {SPEEDS[speedIdx]}×
        </button>

        <audio
          ref={audioRef}
          {...(src ? { src } : {})}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setCurrent(0);
          }}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setElementDuration(d);
          }}
          onError={() => setLoadError(true)}
        />
      </div>

      {transcript && (
        <button type="button" className="audio-transcript-toggle" onClick={() => setShowTranscript((v) => !v)}>
          {showTranscript ? '收起文字' : '查看文字'}
        </button>
      )}
      {showTranscript && transcript && <div className="audio-transcript">{transcript}</div>}
      {!src && !media.error && !loadError && <div className="audio-transcript loading">语音加载中…</div>}
      {(media.error || loadError) && (
        <div className="audio-transcript error">
          {media.error ?? '音频加载失败'}
          {media.retriable && <button type="button" className="audio-retry" onClick={media.retry}>重试</button>}
        </div>
      )}
    </div>
  );
}
