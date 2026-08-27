import { addDaysLocalDate, zonedParts } from '../util/time-zone.js';

export type VisualDayPeriod = 'late-night' | 'morning' | 'midday' | 'afternoon' | 'evening';
export type VisualTimeMode = 'current' | 'retrospective';

export interface VisualTimeContext {
  timeZone: string;
  currentInstant: string;
  currentLocalDate: string;
  currentLocalTime: string;
  currentDayPeriod: VisualDayPeriod;
  mode: VisualTimeMode;
  depictedLocalDate: string;
  depictedDayPeriod: VisualDayPeriod;
  requestedDayPeriod: VisualDayPeriod | null;
}

export interface ResolveVisualTimeInput {
  now: Date | string;
  timeZone?: string;
  latestUserText?: string;
  eventAt?: Date | string | null;
}

const RETROSPECTIVE_WORDING_RE = /(昨天|昨日|昨晚|昨夜|之前|当时|那天|前一晚|前一天|过去|曾经|以前|yesterday|last night|earlier|the previous day|previous day|previously)/i;
const LIGHTING: Record<VisualDayPeriod, string> = {
  'late-night': 'quiet low-key moonlight and cool blue ambient light',
  morning: 'soft warm morning sunlight with fresh, gentle shadows',
  midday: 'clear bright midday daylight with neutral crisp shadows',
  afternoon: 'warm afternoon sunlight with golden, softened shadows',
  evening: 'warm sunset and twilight light with a calm amber glow'
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function localParts(at: Date, timeZone: string) {
  try { return zonedParts(at, timeZone); } catch { return zonedParts(at, 'UTC'); }
}

function localDate(parts: ReturnType<typeof zonedParts>): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function localTime(parts: ReturnType<typeof zonedParts>): string {
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
}

export function visualDayPeriodOfHour(hour: number): VisualDayPeriod {
  if (hour < 5) return 'late-night';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

export function requestedVisualDayPeriod(text?: string): VisualDayPeriod | null {
  if (!text) return null;
  const value = text.toLowerCase();
  if (/(凌晨|半夜|深夜|\bafter midnight\b|\blate[- ]night\b)/i.test(value)) return 'late-night';
  if (/(清晨|早晨|早上|上午|\bmorning\b)/i.test(value)) return 'morning';
  if (/(中午|午间|正午|\bnoon\b|\bmidday\b)/i.test(value)) return 'midday';
  if (/(下午|午后|\bafternoon\b)/i.test(value)) return 'afternoon';
  if (/(傍晚|晚上|今晚|夜里|夜晚|昨晚|夜景|夜间|睡前|晚安|\bevening\b|\btonight\b|\bat night\b|\bnighttime\b|\bbedtime\b)/i.test(value)) return 'evening';
  return null;
}

function hasPastWord(text: string): boolean {
  return RETROSPECTIVE_WORDING_RE.test(text);
}

function isSleepRetrospective(text: string): boolean {
  return /(睡觉|睡眠|sleep(?:ing)?)/i.test(text) && /(晚上|今晚|昨晚|夜间|night|evening)/i.test(text);
}

export function resolveVisualTime(input: ResolveVisualTimeInput): VisualTimeContext {
  const timeZone = input.timeZone?.trim() || 'Asia/Shanghai';
  const now = asDate(input.now);
  if (Number.isNaN(now.getTime())) throw new RangeError('invalid visual time now');
  const currentInstant = now;
  let validZone = true;
  try { zonedParts(currentInstant, timeZone); } catch { validZone = false; }
  const current = localParts(currentInstant, validZone ? timeZone : 'UTC');
  const currentLocalDate = localDate(current);
  const currentLocalTime = localTime(current);
  const currentDayPeriod = visualDayPeriodOfHour(current.hour);
  const text = input.latestUserText ?? '';
  const requestedDayPeriod = validZone ? requestedVisualDayPeriod(text) : null;
  const event = input.eventAt == null ? null : asDate(input.eventAt);
  const validEvent = event && !Number.isNaN(event.getTime()) && event.getTime() <= currentInstant.getTime() && validZone;
  let mode: VisualTimeMode = 'current';
  let depictedLocalDate = currentLocalDate;
  let depictedDayPeriod = currentDayPeriod;
  if (validEvent) {
    const eventParts = localParts(event, timeZone);
    depictedLocalDate = localDate(eventParts);
    depictedDayPeriod = visualDayPeriodOfHour(eventParts.hour);
    mode = depictedLocalDate === currentLocalDate && depictedDayPeriod === currentDayPeriod ? 'current' : 'retrospective';
    return { timeZone, currentInstant: currentInstant.toISOString(), currentLocalDate, currentLocalTime, currentDayPeriod, mode, depictedLocalDate, depictedDayPeriod, requestedDayPeriod: null };
  } else if (validZone && (hasPastWord(text) || (isSleepRetrospective(text) && requestedDayPeriod !== currentDayPeriod))) {
    mode = 'retrospective';
    depictedLocalDate = addDaysLocalDate(currentLocalDate, -1);
    depictedDayPeriod = requestedDayPeriod ?? currentDayPeriod;
  } else if (validZone && requestedDayPeriod && requestedDayPeriod !== currentDayPeriod && !/(夜景|夜间景|\bscene\b|\bscenery\b)/i.test(text)) {
    mode = 'retrospective';
    depictedLocalDate = addDaysLocalDate(currentLocalDate, -1);
    depictedDayPeriod = requestedDayPeriod;
  }
  return { timeZone, currentInstant: currentInstant.toISOString(), currentLocalDate, currentLocalTime, currentDayPeriod, mode, depictedLocalDate, depictedDayPeriod, requestedDayPeriod };
}

export function visualTimeReplyInstruction(time: VisualTimeContext): string {
  const clock = `当前 ${time.currentLocalDate} ${time.currentLocalTime}（${time.timeZone}，${time.currentDayPeriod}）；描绘 ${time.depictedLocalDate}（${time.depictedDayPeriod}）。`;
  return time.mode === 'current'
    ? `${clock} 未明确图片时段时遵循现实当前时间，并覆盖旧提示。`
    : `${clock} 真实时间不可被改写；正文用过去式，允许新生成但不能声称已有历史媒体。`;
}

export function visualDayPeriodLighting(period: VisualDayPeriod): string { return LIGHTING[period]; }

export function visualTimeMetadata(time: VisualTimeContext) {
  return { timeMode: time.mode, timeZone: time.timeZone, currentInstant: time.currentInstant, currentDayPeriod: time.currentDayPeriod, depictedLocalDate: time.depictedLocalDate, depictedDayPeriod: time.depictedDayPeriod, requestedDayPeriod: time.requestedDayPeriod };
}

const CHINESE_PERIOD: Record<VisualDayPeriod, string> = { 'late-night': '凌晨', morning: '早上', midday: '中午', afternoon: '下午', evening: '晚上' };
export function ensureVisualTimeReplyText(text: string, time: VisualTimeContext, hasImage: boolean): string {
  if (!hasImage || time.mode !== 'retrospective' || RETROSPECTIVE_WORDING_RE.test(text)) return text;
  const relation = time.depictedLocalDate === time.currentLocalDate
    ? '今天早些时候'
    : time.depictedLocalDate === addDaysLocalDate(time.currentLocalDate, -1) ? '昨天' : '之前';
  return `现在还是${CHINESE_PERIOD[time.currentDayPeriod]}，不过${relation}倒是有一张这种。`;
}
