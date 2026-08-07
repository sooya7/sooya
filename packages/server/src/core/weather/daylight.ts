import { zonedParts, localDateTimeToUtc, timeZoneOffsetMinutes } from '../../util/time-zone.js';
import type { DaylightSnapshot } from './forecast.js';

/**
 * Daylight（contract §1.2）：sunrise/sunset 优先取 provider 返回，其次
 * 天文算法（NOAA 日出日落近似），都没有时优雅返回 null。isDaylight 永远
 * 按当前时刻即时计算，不用缓存的旧值。天文算法误差约 ±2 分钟，够用。
 */

/** 一个时刻是否在 [sunrise, sunset] 区间内。 */
export function computeIsDaylight(sunriseIso: string, sunsetIso: string, atIso: string): boolean {
  const at = Date.parse(atIso);
  const sunrise = Date.parse(sunriseIso);
  const sunset = Date.parse(sunsetIso);
  if (Number.isNaN(at) || Number.isNaN(sunrise) || Number.isNaN(sunset)) return false;
  return at >= sunrise && at <= sunset;
}

const DEG = Math.PI / 180;

function mod360(x: number): number {
  return ((x % 360) + 360) % 360;
}

function mod24(x: number): number {
  return ((x % 24) + 24) % 24;
}

function mod(x: number, n: number): number {
  return ((x % n) + n) % n;
}

/**
 * NOAA 近似：给定儒略日推进量 t（含经度时差）返回当地真太阳时的日出/日落
 * 钟点（0-24）。极昼/极夜返回 null。
 */
function sunTimeOfDay(t: number, latDeg: number, lngHour: number, isSunset: boolean): number | null {
  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(M * DEG) + 0.02 * Math.sin(2 * M * DEG) + 282.634;
  L = mod360(L);
  let RA = mod360(Math.atan(0.91764 * Math.tan(L * DEG)) / DEG);
  const lq = Math.floor(L / 90) * 90;
  const rq = Math.floor(RA / 90) * 90;
  RA = (RA + (lq - rq)) / 15;
  const sinDec = 0.39782 * Math.sin(L * DEG);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * DEG) - sinDec * Math.sin(latDeg * DEG)) / (cosDec * Math.cos(latDeg * DEG));
  if (cosH > 1 || cosH < -1) return null; // 极昼 / 极夜
  const acosH = Math.acos(cosH) / DEG;
  const H = isSunset ? mod360(acosH) : mod360(360 - acosH);
  const T = H / 15 + RA - 0.06571 * t - 6.622;
  return mod24(T - lngHour); // 当地真太阳时（小时）
}

/**
 * 天文算法估算某地点某天的日出/日落（ISO 时刻）。
 * 需要 lat/lng；时区无效时回退 UTC 日期近似。计算失败（极昼等）返回 null。
 */
export function astronomyDaylight(
  lat: number | null | undefined,
  lng: number | null | undefined,
  at: Date,
  timeZone?: string,
  localDate?: string
): DaylightSnapshot | null {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;
  let dateStr = localDate;
  if (!dateStr) {
    try {
      const parts = zonedParts(at, timeZone ?? 'UTC');
      dateStr = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    } catch {
      dateStr = at.toISOString().slice(0, 10);
    }
  }
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return null;
  // NOAA 的 n 为一年第几天（1 月 1 日 = 1）；Date.UTC(y,0,0) 是上年 12 月 31 日。
  const dayOfYear = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86_400_000) + 1;
  const lngHour = lng / 15;
  const rise = sunTimeOfDay(dayOfYear + (6 - lngHour) / 24, lat, lngHour, false);
  const set = sunTimeOfDay(dayOfYear + (18 - lngHour) / 24, lat, lngHour, true);
  if (rise == null || set == null) return null;
  // NOAA 返回的是 UT 钟点：先换算成本地钟面（UT + 时区偏移，取本地正午的
  // 偏移即可，DST 切换日外误差 <1 分钟），再构成本地日期的真实时刻。
  const utcMinutes = (hours: number): number => Math.round(hours * 60);
  const localOffsetMinutes = (): number => {
    const localNoon = localDateTimeToUtc(dateStr!, 12, 0, timeZone);
    return timeZoneOffsetMinutes(localNoon, timeZone ?? 'UTC');
  };
  const toLocalIso = (hours: number): string => {
    const clockMinutes = mod(utcMinutes(hours) + localOffsetMinutes(), 24 * 60);
    const h = Math.floor(clockMinutes / 60);
    const mnt = clockMinutes % 60;
    return localDateTimeToUtc(dateStr!, h, Math.min(59, mnt), timeZone).toISOString();
  };
  const sunrise = toLocalIso(rise);
  const sunset = toLocalIso(set);
  return { sunrise, sunset, isDaylight: computeIsDaylight(sunrise, sunset, at.toISOString()) };
}
