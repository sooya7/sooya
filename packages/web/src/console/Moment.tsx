import { useEffect, useState } from 'react';
import { adminApi, type AdminLifeOverview, type WeatherStatus } from '../lib/admin.js';

export type Phase = 'dawn' | 'day' | 'dusk' | 'night';

export interface MomentData {
  overview: AdminLifeOverview | null;
  weather: WeatherStatus | null;
  timeZone: string;
}

const CONDITION: Record<string, string> = {
  clear: '晴', cloudy: '多云', rain: '下雨', snow: '下雪', storm: '雷雨', fog: '有雾', wind: '有风', unknown: ''
};

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

export function useMoment(refreshMs = 60_000): MomentData | null {
  const [data, setData] = useState<MomentData | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [overview, weather, cities] = await Promise.allSettled([
        adminApi.lifeOverview(),
        adminApi.weatherStatus(),
        adminApi.lifeCities()
      ]);
      if (!alive) return;
      const active = cities.status === 'fulfilled' ? cities.value.cities.find((city) => city.active) : undefined;
      setData({
        overview: overview.status === 'fulfilled' ? overview.value : null,
        weather: weather.status === 'fulfilled' ? weather.value : null,
        timeZone: active?.timeZone || 'Asia/Shanghai'
      });
    };
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refreshMs]);
  return data;
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

/** The persistent strip: her local time, what she is doing, where, and the shape of her day. */
export function MomentStrip({ data, onOpen }: { data: MomentData | null; onOpen?: () => void }) {
  const now = useNow();
  const timeZone = data?.timeZone ?? 'Asia/Shanghai';
  const minutes = minutesIn(now, timeZone);
  const sunrise = clockMinutes(data?.weather?.daylight?.sunrise, timeZone);
  const sunset = clockMinutes(data?.weather?.daylight?.sunset, timeZone);
  const phase = phaseFor(minutes, sunrise, sunset);
  const clock = new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const overview = data?.overview;
  const activity = overview?.snapshot.activity?.trim();
  const place = [overview?.location?.name, weatherLine(data?.weather ?? null, overview?.weather)].filter(Boolean).join('，');
  const rise = sunrise ?? 6 * 60;
  const set = sunset ?? 18 * 60;
  const day = 24 * 60;

  return (
    <div className="cs-moment" data-phase={phase} data-state={activity ? undefined : 'quiet'} aria-label="她此刻的状态">
      <time className="cs-moment-clock" aria-label={`她那边现在 ${clock}`}>{clock}</time>
      <div className="cs-moment-text">
        <span className="cs-moment-activity">
          {data === null ? '正在看她在做什么…' : activity ? `她在${activity.replace(/^在/, '')}` : '生活模拟没有给出她此刻的状态'}
        </span>
        {place && <span className="cs-moment-place">{place}</span>}
      </div>
      {onOpen ? <button type="button" className="cs-moment-link" onClick={onOpen}>她的一天</button> : <span />}
      <div className="cs-dayline" aria-hidden="true">
        <span className="cs-dayline-lit" style={{ left: `${(rise / day) * 100}%`, width: `${(Math.max(0, set - rise) / day) * 100}%` }} />
        <span className="cs-dayline-now" style={{ left: `${(minutes / day) * 100}%` }} />
      </div>
    </div>
  );
}
