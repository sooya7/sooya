export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function readParts(at: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const values = Object.fromEntries(formatter.formatToParts(at).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second! };
}

export function zonedParts(at: Date, timeZone: string): ZonedParts {
  return readParts(at, timeZone);
}

/** Return the zone offset at an instant; invalid zones deliberately throw. */
export function timeZoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = readParts(at, timeZone);
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at.getTime()) / 60_000);
}

export function formatZonedDateTime(at: Date, timeZone: string): string {
  const parts = readParts(at, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
}

/**
 * Local calendar date (YYYY-MM-DD) of an instant in a zone, with the legacy
 * fixed-offset fallback for old configs that have no IANA zone.
 */
export function localDateOfIso(iso: string, timeZone?: string, fallbackOffsetMinutes = 0): string {
  const at = new Date(iso);
  if (timeZone) {
    try {
      const parts = readParts(at, timeZone);
      return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    } catch { /* fall through */ }
  }
  return new Date(at.getTime() + fallbackOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * UTC instant of a local wall-clock time. Fixed-point iteration over the zone
 * offset: X = naive - offset(X)，偏移稳定即收敛（无 DST 区一次收敛，DST
 * 边缘最多三次）。旧实现第二轮把已修正值当 naive 再减一次偏移，导致
 * IANA 时区结果整体偏差一个偏移量（如 Asia/Shanghai 早 8 小时）——本轮修复。
 * Never built as `localDate + 'T00:00:00Z' + offset` (E5).
 */
export function localDateTimeToUtc(localDate: string, hour: number, minute: number, timeZone?: string, fallbackOffsetMinutes = 0): Date {
  if (timeZone) {
    try {
      const naive = Date.parse(`${localDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
      let guess = naive;
      let previousOffset: number | null = null;
      for (let i = 0; i < 3; i++) {
        const offset = timeZoneOffsetMinutes(new Date(guess), timeZone);
        if (offset === previousOffset) break;
        previousOffset = offset;
        guess = naive - offset * 60_000;
      }
      return new Date(guess);
    } catch { /* fall through */ }
  }
  return new Date(Date.parse(`${localDate}T00:00:00Z`) + fallbackOffsetMinutes * 60_000 + hour * 3_600_000 + minute * 60_000);
}

/** Weekday (0=Sunday) of a local calendar date; independent of any zone. */
export function weekdayOfLocalDate(localDate: string): number {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/**
 * 本地日历日期加/减 N 天（YYYY-MM-DD）。用 UTC 日期运算，仅做纯日历数学，
 * 与时区无关。越界月份/年份由 Date 自动进位。
 */
export function addDaysLocalDate(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number);
  const shifted = new Date(Date.UTC(y!, m! - 1, d! + days));
  return shifted.toISOString().slice(0, 10);
}
