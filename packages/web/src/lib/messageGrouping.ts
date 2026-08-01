import type { ChatMessage } from './types.js';

const GROUP_WINDOW_MS = 5 * 60_000;

export function userTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function localDateKey(iso: string, timeZone = userTimeZone()): string {
  const parts = dateParts(iso, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function shouldStartMessageGroup(previous: ChatMessage | null, current: ChatMessage, timeZone = userTimeZone()): boolean {
  if (!previous) return true;
  if (previous.role === 'system' || current.role === 'system') return true;
  if (previous.meta?.proactive || current.meta?.proactive || previous.meta?.withdrawnAt || current.meta?.withdrawnAt) return true;
  if (previous.role !== current.role) return true;
  const previousTime = Date.parse(previous.createdAt);
  const currentTime = Date.parse(current.createdAt);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return true;
  if (currentTime - previousTime > GROUP_WINDOW_MS) return true;
  return localDateKey(previous.createdAt, timeZone) !== localDateKey(current.createdAt, timeZone);
}

export function shouldStartDateSeparator(previous: ChatMessage | null, current: ChatMessage, timeZone = userTimeZone()): boolean {
  return !previous || localDateKey(previous.createdAt, timeZone) !== localDateKey(current.createdAt, timeZone);
}

export function dateLabel(iso: string, now = new Date(), timeZone = userTimeZone()): string {
  const target = dateParts(iso, timeZone);
  const today = dateParts(now.toISOString(), timeZone);
  const targetDay = Date.UTC(target.year, target.month - 1, target.day);
  const todayDay = Date.UTC(today.year, today.month - 1, today.day);
  const delta = Math.round((todayDay - targetDay) / 86_400_000);
  if (delta === 0) return '今天';
  if (delta === 1) return '昨天';
  return `${target.year}年${target.month}月${target.day}日`;
}

function dateParts(value: string, timeZone: string): { year: number; month: number; day: number } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { year: 1970, month: 1, day: 1 };
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value ?? 1970),
    month: Number(parts.find((part) => part.type === 'month')?.value ?? 1),
    day: Number(parts.find((part) => part.type === 'day')?.value ?? 1)
  };
}
