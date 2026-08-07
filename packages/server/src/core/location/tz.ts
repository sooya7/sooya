/**
 * 时区纯函数工具（Location 模块）。
 *
 * 统一约定：所有"本地时间"推导一律走 IANA 时区（默认 Asia/Shanghai），
 * 禁止 `getUTCHours() + 8` 这类写死偏移的做法 —— 城市切换后时区必须跟着变。
 * 本模块只依赖 Intl，不读 env、不碰数据库，后续模块（weather/metrics 等）可复用。
 */

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export interface LocalTimeParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  hour: number;  // 0-23
  minute: number;
  second: number;
}

/** 格式化器缓存：同一时区不重复构造（Intl 构造开销不小）。 */
const FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let fmt = FORMATTER_CACHE.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      // h23 避免部分环境午夜输出 '24'
      hourCycle: 'h23'
    });
    FORMATTER_CACHE.set(zone, fmt);
  }
  return fmt;
}

/** IANA 时区名是否合法（非法时区 Intl 会抛 RangeError）。 */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** 把 UTC 时刻换算成指定 IANA 时区的本地日历分量。 */
export function localTimeParts(at: Date, zone: string): LocalTimeParts {
  const parts = formatterFor(zone).formatToParts(at);
  const out: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0
  };
}

/** 本地日期，YYYY-MM-DD（例如归档键、WorldSnapshot.localDate）。 */
export function localDateAt(at: Date, zone: string): string {
  const p = localTimeParts(at, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 本地小时 0-23（选择器时段窗口用）。 */
export function localHourAt(at: Date, zone: string): number {
  return localTimeParts(at, zone).hour;
}

/** IANA 时区相对 UTC 的分钟偏移（含夏令时，由 Intl 保证正确性）。 */
export function utcOffsetMinutesAt(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = /^GMT([+-])(\d{1,2}):(\d{2})$/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}
