import type { LifePanelData, LifeSnapshot } from './features.js';

/*
 * 她不开口时，界面上唯一能看到的现象就是「没消息」——被上限挡住、在静默时段、还是
 * 根本没有值得说的事，看起来完全一样。这里把服务端给的 reason 翻成一句能照着改设置
 * 的话，并把时间换算到她所在的时区（她是 UTC+8，浏览器不一定是）。
 */

export const REACH_REASON_LABELS: Record<string, string> = {
  ok: '条件满足，下一次 tick 就会开口',
  disabled: '你在这个页面关掉了主动开口',
  deployment_disabled: '部署层关掉了主动开口（改 .env 的 ENABLE_LIFE_REACH_OUT）',
  silent_hours: '在静默时段里，她不打扰你',
  asleep: '她在睡觉',
  user_was_recently_here: '你刚说过话，她要等满安静间隔',
  already_spoke: '上一条还是她说的，不叠着发',
  daily_cap: '今天的主动条数已经用完',
  nothing_worth_saying: '还没有做完、且没跟你说过的事'
};

export function reachReasonText(data: Pick<LifePanelData, 'reachOut' | 'settings'>): string {
  const { reachOut, settings } = data;
  if (!reachOut.enabledByDeployment) return REACH_REASON_LABELS.deployment_disabled!;
  const base = REACH_REASON_LABELS[reachOut.reason] ?? reachOut.reason;
  if (reachOut.reason === 'user_was_recently_here' && reachOut.lastUserAt) {
    return `${base}（间隔 ${settings.quietGapMinutes} 分钟，你上次说话在 ${formatGap(Date.now() - Date.parse(reachOut.lastUserAt))}前）`;
  }
  if (reachOut.reason === 'daily_cap') {
    return `${base}（${reachOut.sharedLastDay}/${settings.maxReachOutsPerDay}）`;
  }
  if (reachOut.reason === 'silent_hours') {
    return `${base}（${pad(settings.silentFrom)}:00 – ${pad(settings.silentTo)}:00）`;
  }
  return base;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatGap(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/** 换算到她的本地时区再格式化，界面上的钟点必须跟她说的话一致。 */
export function herClock(iso: string | null | undefined, tzOffsetMinutes: number): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const shifted = new Date(ms + tzOffsetMinutes * 60_000);
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

export interface SlotProgress {
  percent: number;
  intoIt: string;
  left: string;
}

/** 这段活动进行到哪了。超出边界时钳到 0/100，不会画出跑出格子的进度条。 */
export function slotProgress(snapshot: Pick<LifeSnapshot, 'startedAt' | 'endsAt'>, now = Date.now()): SlotProgress {
  const start = Date.parse(snapshot.startedAt);
  const end = Date.parse(snapshot.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { percent: 0, intoIt: '—', left: '—' };
  }
  const ratio = (now - start) / (end - start);
  return {
    percent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    intoIt: formatGap(now - start),
    left: formatGap(end - now)
  };
}

/** 生活日志：她做过什么、说过没说过。倒序，最新在上。 */
export function sortedLog<T extends { started_at: string }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => b.started_at.localeCompare(a.started_at));
}
