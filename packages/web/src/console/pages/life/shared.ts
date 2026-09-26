import { createContext, useContext } from 'react';
import type { AdminLifeVitals } from '../../../lib/admin.js';

/* ------------------------------------------------------------ page context */

export interface LifeContextValue {
  /** Bumped after any action that changes her state; sections reload on it. */
  version: number;
  /** Bumped every minute; only the "right now" sections follow it. */
  pulse: number;
  refresh: () => void;
  /** Her UTC offset in minutes (she lives in UTC+8; the browser may not). */
  tz: number;
  /** A form on this page now holds unsaved input. */
  touch: (key: string) => void;
  /** That form was saved or discarded; clears the shell's "unsaved" mark once nothing else is pending. */
  settle: (key: string) => void;
}

export const LifeContext = createContext<LifeContextValue>({
  version: 0, pulse: 0, refresh: () => {}, tz: 480, touch: () => {}, settle: () => {}
});

export const useLife = () => useContext(LifeContext);

/* ------------------------------------------------------------------ vitals */

export type VitalKey = keyof AdminLifeVitals;

export const VITALS: Array<{ key: VitalKey; label: string; direction: 'high-bad' | 'low-bad'; hint: string }> = [
  { key: 'energy', label: '精力', direction: 'low-bad', hint: '低了会想休息、回得更短' },
  { key: 'focus', label: '专注', direction: 'low-bad', hint: '影响她能不能坐得住做事' },
  { key: 'comfort', label: '舒适', direction: 'low-bad', hint: '冷热、累不累、环境好不好' },
  { key: 'curiosity', label: '好奇', direction: 'low-bad', hint: '高了会想尝试新东西' },
  { key: 'hunger', label: '饥饿', direction: 'high-bad', hint: '高了会想去吃东西' },
  { key: 'stress', label: '压力', direction: 'high-bad', hint: '高了语气会更紧绷' },
  { key: 'loneliness', label: '孤单', direction: 'high-bad', hint: '高了更想有人陪' },
  { key: 'social_need', label: '想找人说话', direction: 'high-bad', hint: '高了更可能主动分享' }
];

/**
 * Vitals arrive either on a 0..100 or a 0..1 scale. Decide once for the whole
 * row so a genuinely low 0..100 value (say 0.8) is not mistaken for 80%.
 */
export function vitalsScale(vitals: AdminLifeVitals): 1 | 100 {
  return VITALS.some(({ key }) => Number(vitals[key]) > 1) ? 100 : 1;
}

export function vitalTone(value: number, direction: 'high-bad' | 'low-bad'): 'warn' | 'bad' | undefined {
  const risk = direction === 'high-bad' ? value : 1 - value;
  return risk >= 0.8 ? 'bad' : risk >= 0.6 ? 'warn' : undefined;
}

/** Progress / heat on threads: 0..1 from the raw table, 0..100 from the overview. */
export function fraction(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

/* ------------------------------------------------------------------ labels */

export const LOCATION_KINDS: Array<{ value: string; label: string }> = [
  { value: 'home', label: '家' },
  { value: 'neighborhood', label: '家附近' },
  { value: 'cafe', label: '咖啡店' },
  { value: 'restaurant', label: '餐馆' },
  { value: 'store', label: '商店' },
  { value: 'park', label: '公园' },
  { value: 'library', label: '图书馆' },
  { value: 'mall', label: '商场' },
  { value: 'transit', label: '车站' },
  { value: 'work', label: '工作的地方' },
  { value: 'study', label: '学习的地方' },
  { value: 'venue', label: '场馆' },
  { value: 'outdoor', label: '户外' },
  { value: 'other', label: '其他' }
];

export function locationKindLabel(kind: string): string {
  return LOCATION_KINDS.find((item) => item.value === kind)?.label ?? kind;
}

export const PLAN_KINDS: Array<{ value: string; label: string }> = [
  { value: 'task', label: '要办的事' },
  { value: 'out', label: '出门' },
  { value: 'play', label: '玩' },
  { value: 'meal', label: '吃饭' },
  { value: 'study', label: '学习' },
  { value: 'work', label: '工作' },
  { value: 'reading', label: '阅读' },
  { value: 'chore', label: '家务' },
  { value: 'rest', label: '休息' }
];

export const TRAVEL_MODE: Record<string, string> = { walk: '走路', bike: '骑车', transit: '坐公交地铁', car: '坐车', unknown: '' };

export const PLAN_STATUS: Record<string, string> = {
  planned: '打算做', active: '正在做', paused: '先放着', completed: '做完了', cancelled: '不做了', skipped: '没去做'
};

export function planStatusLabel(status: string): string {
  return PLAN_STATUS[status] ?? status;
}

export const PLAN_SOURCE: Record<string, string> = {
  routine: '日常作息', generated: '她自己想的', admin: '你加的', conversation: '聊天里说起的'
};

export const THREAD_STATUS: Record<string, string> = {
  open: '还惦记着', paused: '暂时放下', resolved: '已经了结', abandoned: '不再想了'
};

const THREAD_CATEGORY: Record<string, string> = {
  admin: '你加的', follow_up: '答应过的事', conversation: '聊天里说起的', interest: '感兴趣的'
};

export function threadCategoryLabel(value: string): string {
  return THREAD_CATEGORY[value] ?? value;
}

/* -------------------------------------------------------------------- time */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function shifted(iso: string | null | undefined, tz: number): Date | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms + tz * 60_000) : null;
}

/** Her calendar day, "2026-09-26". */
export function herDay(iso: string | null | undefined, tz: number): string | null {
  return shifted(iso, tz)?.toISOString().slice(0, 10) ?? null;
}

export function herToday(tz: number): string {
  return herDay(new Date().toISOString(), tz)!;
}

/** "14:05" when it is her today, otherwise "9月25日 14:05". */
export function herWhen(iso: string | null | undefined, tz: number): string {
  const d = shifted(iso, tz);
  if (!d) return '—';
  const clock = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (herDay(iso, tz) === herToday(tz)) return clock;
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${clock}`;
}

export function herRange(start: string | null | undefined, end: string | null | undefined, tz: number): string {
  if (!start && !end) return '没定时间';
  if (!end) return `${herWhen(start, tz)} 开始`;
  if (!start) return `${herWhen(end, tz)} 前`;
  const endText = herDay(start, tz) === herDay(end, tz) ? herWhen(end, tz).slice(-5) : herWhen(end, tz);
  return `${herWhen(start, tz)}–${endText}`;
}

/** ISO → value for <input type="datetime-local">, in her time zone. */
export function toHerInput(iso: string | null | undefined, tz: number): string {
  const d = shifted(iso, tz);
  if (!d) return '';
  return d.toISOString().slice(0, 16);
}

/** <input type="datetime-local"> value read in her time zone → ISO, or null when empty. */
export function fromHerInput(value: string, tz: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return new Date(utc - tz * 60_000).toISOString();
}

/** Whether the browser sits in a different zone from her, so time inputs need a note. */
export function browserDiffers(tz: number): boolean {
  return -new Date().getTimezoneOffset() !== tz;
}

export function parseJsonArray(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
  } catch {
    return [];
  }
}
