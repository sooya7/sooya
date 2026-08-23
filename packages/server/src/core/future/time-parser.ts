/**
 * Deterministic commitment time resolution (§6).
 *
 * The model only ever quotes the user ("周五", "晚上八点"); this module is the
 * single place that turns those words into absolute ISO timestamps using the
 * message time and the user's timezone. No LLM ever produces an ISO date.
 */

export type TimePrecision = 'exact' | 'day' | 'range' | 'relative' | 'unknown';

export interface ResolvedCommitmentTime {
  /** Start of the mentioned window (day precision → local midnight). */
  startsAt: string | null;
  /** When the item becomes actionable (day precision → end of that day). */
  dueAt: string | null;
  /** Latest sane moment to still reach out about it. */
  latestReachOutAt: string | null;
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 1 (Mon) .. 7 (Sun)
  hour: number; // 0-23
  minute: number;
}

const WEEKDAY_NAMES: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7
};

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 二十四: 24 };
const CN_UNITS: Record<string, number> = { 半: 30, 一刻: 15, 三刻: 45, 二十: 20, 四十: 40 };

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short'
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdays[parts.weekday ?? 'Mon'] ?? 1,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute)
  };
}

/** UTC instant for a wall-clock time in `timeZone` (two-pass, DST-safe). */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // offset = "the wall clock read in tz, reinterpreted as UTC" - actual UTC.
  const offsetAt = (utcMs: number): number => {
    const p = zonedParts(new Date(utcMs), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - utcMs;
  };
  let ts = guess - offsetAt(guess);
  ts = guess - offsetAt(ts);
  return new Date(ts);
}

/** Local calendar date (YYYY-MM-DD) of an ISO instant in `timeZone`. */
export function isoToZonedDate(iso: string, timeZone: string): string {
  const parts = zonedParts(new Date(iso), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function addDays(parts: ZonedParts, days: number, timeZone: string): ZonedParts {
  const base = zonedToUtc(parts.year, parts.month, parts.day, 12, 0, timeZone);
  return zonedParts(new Date(base.getTime() + days * 86_400_000), timeZone);
}

function dayDiff(target: number, today: number): number {
  const diff = (target - today + 7) % 7;
  // "周五" said on a Friday means the coming one, not zero minutes from now.
  return diff === 0 ? 7 : diff;
}

/** Resolve the day part of a date_text; returns days-from-today, or null. */
export function parseDayOffset(dateText: string, now: Date, timeZone: string): number | null {
  const t = dateText.trim().replace(/\s+/g, '');
  if (!t) return null;
  const today = zonedParts(now, timeZone);

  if (/^大后天$/.test(t)) return 3;
  if (/^(后天|後天)$/.test(t)) return 2;
  if (/^(明天|明日|明儿)$/.test(t)) return 1;
  if (/^(今天|今日|当晚|今晚)$/.test(t)) return 0;

  // "3天后" / "三天后"
  const afterDays = /^([0-9]+|[一二两三四五六七八九十]+)天后?$/.exec(t);
  if (afterDays?.[1]) {
    const n = CN_DIGITS[afterDays[1]] ?? Number(afterDays[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 365) return n;
  }

  // 周X / 星期X / 礼拜X, optionally 下周/本周/这周
  const weekdayMatch = /^(?:下|本|这)?(?:周|星期|礼拜)([一二三四五六日天1-7])$/.exec(t);
  if (weekdayMatch?.[1]) {
    const target = WEEKDAY_NAMES[weekdayMatch[1]];
    if (target) {
      if (t.startsWith('下')) {
        const daysToNextMonday = (8 - today.weekday) % 7 || 7;
        return daysToNextMonday + ((target - 1 + 7) % 7);
      }
      return dayDiff(target, today.weekday);
    }
  }

  // X月X日 / X月X号, optionally with year
  const monthDay = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]?$/.exec(t);
  if (monthDay) {
    const year = monthDay[1] ? Number(monthDay[1]) : today.year;
    const month = Number(monthDay[2]);
    const day = Number(monthDay[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let candidate = zonedToUtc(year, month, day, 12, 0, timeZone);
      // "6月1号" said in July means next year's June, not two months ago.
      if (candidate.getTime() < now.getTime() - 86_400_000 && !monthDay[1]) {
        candidate = zonedToUtc(year + 1, month, day, 12, 0, timeZone);
      }
      const from = zonedToUtc(today.year, today.month, today.day, 12, 0, timeZone);
      return Math.round((candidate.getTime() - from.getTime()) / 86_400_000);
    }
  }

  // 2026-08-28 / 08-28 / 8/28
  const numeric = /^(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})$/.exec(t);
  if (numeric) {
    const year = numeric[1] ? Number(numeric[1]) : today.year;
    const month = Number(numeric[2]);
    const day = Number(numeric[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let candidate = zonedToUtc(year, month, day, 12, 0, timeZone);
      if (candidate.getTime() < now.getTime() - 86_400_000 && !numeric[1]) {
        candidate = zonedToUtc(year + 1, month, day, 12, 0, timeZone);
      }
      const from = zonedToUtc(today.year, today.month, today.day, 12, 0, timeZone);
      return Math.round((candidate.getTime() - from.getTime()) / 86_400_000);
    }
  }

  return null;
}

/** Resolve a time-of-day ("晚上八点半", "14:30"); returns minutes since midnight, or null. */
export function parseMinuteOfDay(timeText: string): number | null {
  const t = timeText.trim().replace(/\s+/g, '');
  if (!t) return null;

  const hhmm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (hhmm) return Number(hhmm[1]) * 60 + Number(hhmm[2]);

  const meridiem = /^(凌晨|早上|上午|中午|下午|傍晚|晚上|今晚|明晚|清晨|夜里|今晚)?(?:)(?:(\d{1,2}|[一二两三四五六七八九十]{1,2}|二十四)点)(半|一刻|三刻|[0-5]?\d分|[二三四]十[0-5]分)?$/.exec(t);
  if (!meridiem) return null;
  const part = meridiem[1] ?? '';
  const hourRaw = meridiem[2]!;
  let hour = CN_DIGITS[hourRaw] ?? Number(hourRaw);
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) return null;

  if (part === '凌晨' || part === '清晨' || part === '夜里') {
    // keep as-is: 凌晨两点 = 02:00 (12 → 0)
    if (hour === 12) hour = 0;
  } else if (part === '中午') {
    if (hour === 12) hour = 12; // 中午十二点 = 12:00
    else if (hour <= 2) hour += 12; // 中午一点 ≈ 13:00
  } else if (part === '下午' || part === '傍晚') {
    if (hour < 12) hour += 12;
  } else if (part === '晚上' || part === '今晚' || part === '明晚') {
    if (hour === 12) hour = 24; // 晚上十二点 = midnight of the coming night
    else if (hour < 12) hour += 12;
  } else if (hour <= 12 && /(下午|晚上)/.test(part) === false) {
    // bare "八点": ambiguous, treat as daytime clock order (08:00). The
    // analyzer is instructed to always emit a meridiem prefix.
  }
  if (hour === 24) return 24 * 60;

  const suffix = meridiem[3] ?? '';
  let minute = 0;
  if (suffix) {
    if (suffix === '半') minute = 30;
    else if (CN_UNITS[suffix] !== undefined) minute = CN_UNITS[suffix]!;
    else minute = Number(suffix.replace('分', ''));
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) minute = 0;
  }
  return hour * 60 + minute;
}

/**
 * Combine date_text + time_text into absolute times. Returns null when neither
 * side resolves — the commitment stays undated rather than guessing.
 */
export function resolveCommitmentTime(opts: {
  dateText?: string | null;
  timeText?: string | null;
  now: Date;
  timeZone: string;
}): ResolvedCommitmentTime | null {
  const dayOffset = opts.dateText ? parseDayOffset(opts.dateText, opts.now, opts.timeZone) : null;
  const minuteOfDay = opts.timeText ? parseMinuteOfDay(opts.timeText) : null;
  if (dayOffset === null && minuteOfDay === null) return null;

  const today = zonedParts(opts.now, opts.timeZone);
  if (dayOffset === null && minuteOfDay !== null) {
    // "晚上八点" with no date: earliest sensible reading is today — but a
    // time already past today belongs to tomorrow ("晚上八点见" said at 23:00).
    let day = today;
    if (zonedToUtc(today.year, today.month, today.day, 0, 0, opts.timeZone).getTime() + minuteOfDay * 60_000 <= opts.now.getTime()) {
      day = addDays(today, 1, opts.timeZone);
    }
    const start = zonedToUtc(day.year, day.month, day.day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, opts.timeZone);
    return {
      startsAt: start.toISOString(),
      dueAt: start.toISOString(),
      latestReachOutAt: new Date(start.getTime() + 2 * 3_600_000).toISOString()
    };
  }

  // Day (possibly with a time) resolved.
  const day = dayOffset === 0 ? today : addDays(today, dayOffset!, opts.timeZone);
  if (minuteOfDay !== null) {
    const hour = Math.floor(minuteOfDay / 60);
    const minute = minuteOfDay % 60;
    const start = zonedToUtc(day.year, day.month, day.day, hour === 24 ? 23 : hour, hour === 24 ? 59 : minute, opts.timeZone);
    return {
      startsAt: start.toISOString(),
      dueAt: start.toISOString(),
      latestReachOutAt: new Date(start.getTime() + 2 * 3_600_000).toISOString()
    };
  }
  const startsAt = zonedToUtc(day.year, day.month, day.day, 0, 0, opts.timeZone);
  const dayEnd = zonedToUtc(day.year, day.month, day.day, 23, 59, opts.timeZone);
  return {
    startsAt: startsAt.toISOString(),
    dueAt: dayEnd.toISOString(),
    latestReachOutAt: dayEnd.toISOString()
  };
}
