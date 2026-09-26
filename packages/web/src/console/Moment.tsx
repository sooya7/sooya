import { useCallback, useEffect, useState } from 'react';
import { adminApi, type AdminLifeOverview, type AdminPersona, type WeatherStatus } from '../lib/admin.js';
import { mediaThumbnailPath } from '../lib/authenticatedMedia.js';
import { useAuthenticatedMedia } from '../lib/useAuthenticatedMedia.js';
import { Icon } from './icons.js';

export type Phase = 'dawn' | 'day' | 'dusk' | 'night';

export interface MomentData {
  overview: AdminLifeOverview | null;
  weather: WeatherStatus | null;
  persona: Pick<AdminPersona, 'name' | 'avatar' | 'tagline'> | null;
  timeZone: string;
  city: string | null;
}

const CONDITION: Record<string, string> = {
  clear: '晴', cloudy: '多云', rain: '下雨', snow: '下雪', storm: '雷雨', fog: '有雾', wind: '有风', unknown: ''
};

const PHASE_LABEL: Record<Phase, string> = { dawn: '清晨', day: '白天', dusk: '傍晚', night: '夜里' };

/** Minutes since local midnight in the given zone. */
export function minutesIn(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

/** Accepts "06:12", "06:12:30" or a full timestamp. */
export function clockMinutes(value: string | null | undefined, timeZone: string): number | null {
  if (!value) return null;
  const hm = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : minutesIn(date, timeZone);
}

const TWILIGHT = 45;

export function phaseFor(now: number, sunrise: number | null, sunset: number | null): Phase {
  const rise = sunrise ?? 6 * 60;
  const set = sunset ?? 18 * 60;
  if (Math.abs(now - rise) <= TWILIGHT) return 'dawn';
  if (Math.abs(now - set) <= TWILIGHT) return 'dusk';
  return now > rise && now < set ? 'day' : 'night';
}

export function useMoment(refreshMs = 60_000): { data: MomentData | null; reload: () => void } {
  const [data, setData] = useState<MomentData | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [overview, weather, cities, persona] = await Promise.allSettled([
        adminApi.lifeOverview(),
        adminApi.weatherStatus(),
        adminApi.lifeCities(),
        adminApi.persona()
      ]);
      if (!alive) return;
      const active = cities.status === 'fulfilled' ? cities.value.cities.find((city) => city.active) : undefined;
      setData({
        overview: overview.status === 'fulfilled' ? overview.value : null,
        weather: weather.status === 'fulfilled' ? weather.value : null,
        persona: persona.status === 'fulfilled' ? persona.value.persona : null,
        timeZone: active?.timeZone || 'Asia/Shanghai',
        city: active?.name ?? null
      });
    };
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refreshMs, tick]);
  return { data, reload };
}

function useNow(stepMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

export function weatherLine(weather: WeatherStatus | null, fallback: string | null | undefined): string {
  const snap = weather?.lastSnapshot;
  if (!snap) return fallback ?? '';
  const condition = CONDITION[snap.condition] ?? '';
  const temp = typeof snap.temperatureC === 'number' ? `${Math.round(snap.temperatureC)}°` : '';
  return [condition, temp].filter(Boolean).join(' ');
}

function weatherIcon(weather: WeatherStatus | null, phase: Phase): string {
  const condition = weather?.lastSnapshot?.condition;
  if (condition && condition !== 'unknown' && condition !== 'clear') return condition;
  return phase === 'night' ? 'cloudy' : 'clear';
}

/** Everything the strip and the hero both need, derived once. */
function useDay(data: MomentData | null) {
  const now = useNow();
  const timeZone = data?.timeZone ?? 'Asia/Shanghai';
  const minutes = minutesIn(now, timeZone);
  const sunrise = clockMinutes(data?.weather?.daylight?.sunrise, timeZone);
  const sunset = clockMinutes(data?.weather?.daylight?.sunset, timeZone);
  const phase = phaseFor(minutes, sunrise, sunset);
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const date = new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'long', day: 'numeric', weekday: 'short' }).format(now);
  const overview = data?.overview;
  const activity = overview?.snapshot.activity?.trim();
  const place = [data?.city, overview?.location?.name].filter((v, i, all) => v && all.indexOf(v) === i).join('，');
  const weather = weatherLine(data?.weather ?? null, overview?.weather);
  return { minutes, sunrise, sunset, phase, clock, date, overview, activity, place, weather };
}

function fmtClock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The sky over her day. By day the sun rides an arc from sunrise to sunset; by night the
 * moon rides the same arc from sunset to the next sunrise. The travelled part is drawn solid.
 */
export function SkyArc({ minutes, sunrise, sunset, width = 176, height = 56, labels = true }: {
  minutes: number; sunrise: number | null; sunset: number | null; width?: number; height?: number; labels?: boolean;
}) {
  const rise = sunrise ?? 6 * 60;
  const set = sunset ?? 18 * 60;
  const day = minutes >= rise && minutes <= set;
  const span = day ? set - rise : 24 * 60 - (set - rise);
  const since = day ? minutes - rise : (minutes - set + 24 * 60) % (24 * 60);
  const t = Math.max(0, Math.min(1, span > 0 ? since / span : 0));
  const pad = 10;
  const base = height - (labels ? 14 : 6);
  const top = 8;
  const x0 = pad;
  const x1 = width - pad;
  const point = (p: number) => [x0 + (x1 - x0) * p, base - (base - top) * Math.sin(Math.PI * p)] as const;
  const arc = Array.from({ length: 41 }, (_, i) => point(i / 40)).map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const steps = Math.max(1, Math.round(40 * t));
  const trail = Array.from({ length: steps + 1 }, (_, i) => point((t * i) / steps)).map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [sx, sy] = point(t);
  return (
    <svg className="cs-sky" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={day ? `日出 ${fmtClock(rise)}，日落 ${fmtClock(set)}` : `日落 ${fmtClock(set)}，日出 ${fmtClock(rise)}`}>
      <line className="cs-sky-horizon" x1={2} x2={width - 2} y1={base} y2={base} />
      <path className="cs-sky-arc" d={arc} />
      <path className="cs-sky-trail" d={trail} />
      <circle className="cs-sky-halo" cx={sx} cy={sy} r={9} />
      {day
        ? <circle className="cs-sky-sun" cx={sx} cy={sy} r={4.5} />
        : <path className="cs-sky-sun" d={`M${sx + 1.5} ${sy - 5}a5 5 0 1 0 3.5 8.6a4 4 0 1 1-3.5-8.6Z`} />}
      {labels && (
        <>
          <text className="cs-sky-label" x={x0} y={height - 2} textAnchor="start">{fmtClock(day ? rise : set)}</text>
          <text className="cs-sky-label" x={x1} y={height - 2} textAnchor="end">{fmtClock(day ? set : rise)}</text>
        </>
      )}
    </svg>
  );
}

/** Her avatar through the authenticated media path; falls back to the first character of her name. */
export function HerAvatar({ persona, size }: { persona: MomentData['persona']; size?: 'lg' | 'xl' }) {
  const px = size === 'xl' ? 88 : size === 'lg' ? 52 : 40;
  const url = persona?.avatar;
  const media = useAuthenticatedMedia(url ? mediaThumbnailPath(url, px) : null, 'admin', 'image');
  return (
    <span className="cs-avatar" data-size={size} data-ring="">
      {media.url ? <img src={media.url} alt="" /> : <span aria-hidden="true">{persona?.name?.slice(0, 1) ?? ''}</span>}
    </span>
  );
}

/** The persistent strip on every page but the landing page. */
export function MomentStrip({ data, onOpen }: { data: MomentData | null; onOpen?: () => void }) {
  const d = useDay(data);
  return (
    <div className="cs-moment" data-phase={d.phase} data-state={d.activity ? undefined : 'quiet'} aria-label="她此刻的状态">
      <HerAvatar persona={data?.persona ?? null} />
      <div className="cs-moment-time">
        <time className="cs-moment-clock" aria-label={`她那边现在 ${d.clock}`}>{d.clock}</time>
        <span className="cs-moment-day">{PHASE_LABEL[d.phase]}</span>
      </div>
      <div className="cs-moment-text">
        <span className="cs-moment-activity">
          {data === null ? '正在看她在做什么…' : d.activity ? `她在${d.activity.replace(/^在/, '')}` : '生活模拟没有给出她此刻的状态'}
        </span>
        {(d.place || d.weather) && (
          <span className="cs-moment-place">
            <Icon name={weatherIcon(data?.weather ?? null, d.phase)} size={16} />
            <span>{[d.place, d.weather].filter(Boolean).join('，')}</span>
          </span>
        )}
      </div>
      <div className="cs-moment-side">
        {onOpen && <button type="button" className="cs-moment-link" onClick={onOpen}>她的一天</button>}
        <SkyArc minutes={d.minutes} sunrise={d.sunrise} sunset={d.sunset} />
      </div>
      {/* phones get the day as a thin line instead of the arc: daylight lit, a dot for now */}
      <span className="cs-moment-progress" aria-hidden="true">
        <span className="cs-moment-progress-lit" style={{ left: `${((d.sunrise ?? 360) / 1440) * 100}%`, width: `${(Math.max(0, (d.sunset ?? 1080) - (d.sunrise ?? 360)) / 1440) * 100}%` }} />
        <span className="cs-moment-progress-now" style={{ left: `${(d.minutes / 1440) * 100}%` }} />
      </span>
    </div>
  );
}

/** The landing page's large version of the strip. */
export function MomentHero({ data }: { data: MomentData | null }) {
  const d = useDay(data);
  const mood = d.overview?.snapshot.mood;
  return (
    <header className="cs-hero" data-phase={d.phase} aria-label="她此刻的状态">
      <div>
        <div className="cs-hero-who">
          <HerAvatar persona={data?.persona ?? null} size="lg" />
          <div>
            <div className="cs-hero-name">{data?.persona?.name ?? ' '}</div>
            {data?.persona?.tagline && <div className="cs-hero-meta">{data.persona.tagline}</div>}
          </div>
        </div>
        <p className="cs-hero-line">
          {data === null ? '正在看她在做什么…'
            : d.activity ? `她在${d.activity.replace(/^在/, '')}${mood ? `，心情${mood}` : ''}。`
              : '生活模拟没有给出她此刻的状态。'}
        </p>
        <div className="cs-hero-sub">
          {d.place && <span><Icon name="life" size={16} />{d.place}</span>}
          {d.weather && <span><Icon name={weatherIcon(data?.weather ?? null, d.phase)} size={16} />{d.weather}</span>}
          {d.overview?.snapshot.theme && <span><Icon name="now" size={16} />今天是{d.overview.snapshot.theme}</span>}
          {d.overview?.activePlan && <span><Icon name="memory" size={16} />在做的计划：{d.overview.activePlan.title}</span>}
        </div>
      </div>
      <div className="cs-hero-clock">
        <time aria-label={`她那边现在 ${d.clock}`}>{d.clock}</time>
        <span>{d.date}，{PHASE_LABEL[d.phase]}</span>
        <SkyArc minutes={d.minutes} sunrise={d.sunrise} sunset={d.sunset} width={260} height={78} />
      </div>
    </header>
  );
}
