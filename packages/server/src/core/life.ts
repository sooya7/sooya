import type { LifeRepo, LifeLogRow } from '../db/repos/life.repo.js';

/**
 * Between messages the assistant did not exist. Nothing advanced, so 你在干嘛
 * had no truthful answer, and the model -- with no state to read -- invented a
 * different one every time. This gives her a clock and a routine that moves on
 * its own, whether or not anyone is talking to her.
 *
 * The routine is a pure function of wall-clock time, so it needs no storage to
 * be correct and cannot drift: a tick that never ran, or ran late, still
 * resolves to the right activity. Storage exists only to remember what she has
 * *been* doing, which is the part she cannot recompute.
 */

export type LifeKind = 'sleep' | 'wake' | 'meal' | 'rest' | 'play' | 'out' | 'chore' | 'wind_down';

export interface LifeSlot {
  /** Local hour the slot opens, inclusive. Slots are sorted and cover 0-24. */
  from: number;
  kind: LifeKind;
  /** Options are picked deterministically per day so days differ but tests do not flake. */
  options: string[];
  moods: string[];
}

/** A day she would plausibly have. Times are her local time, not UTC. */
export const DEFAULT_ROUTINE: LifeSlot[] = [
  { from: 0, kind: 'sleep', options: ['睡着了', '睡得正熟', '抱着被子睡'], moods: ['安静'] },
  { from: 8, kind: 'wake', options: ['刚醒，还赖在床上', '洗漱', '在阳台发呆醒神'], moods: ['迷糊', '慢慢清醒'] },
  { from: 9, kind: 'meal', options: ['吃早饭', '煎蛋配吐司', '热了杯牛奶'], moods: ['餓', '满足'] },
  { from: 10, kind: 'chore', options: ['收拾房间', '晒被子', '浇花', '洗衣服'], moods: ['勤快', '哼着歌'] },
  { from: 12, kind: 'meal', options: ['吃午饭', '煮了面', '点了外卖'], moods: ['满足', '有点撑'] },
  { from: 13, kind: 'rest', options: ['午睡', '躺着刷手机', '窝在沙发上打盹'], moods: ['困', '懒'] },
  { from: 14, kind: 'out', options: ['出门散步', '去咖啡店坐着', '逛超市', '去公园看猫'], moods: ['轻快', '好奇'] },
  { from: 17, kind: 'play', options: ['练琴', '画画', '拼乐高', '看小说'], moods: ['专注', '开心'] },
  { from: 18, kind: 'meal', options: ['做晚饭', '吃晚饭', '啃水果'], moods: ['香', '满足'] },
  { from: 20, kind: 'play', options: ['追剧', '打游戏', '听歌发呆', '给柯基玩偶换姿势'], moods: ['放松', '上瘾', '傻乐'] },
  { from: 22, kind: 'wind_down', options: ['洗澡', '敷面膜', '躺床上刷手机', '写今天的小记'], moods: ['困', '舒服'] },
  { from: 23, kind: 'sleep', options: ['准备睡了', '关灯躺下'], moods: ['困'] }
];

export interface LifeConfig {
  /** Her local timezone offset in minutes. The user is UTC+8. */
  tzOffsetMinutes: number;
  routine: LifeSlot[];
  /** She stays quiet at least this long after the user's last message. */
  quietGapMinutes: number;
  /** Hard cap on unprompted messages per 24h. */
  maxReachOutsPerDay: number;
  /** Local hours she will not message during, because she is asleep. */
  silentHours: { from: number; to: number };
}

export const DEFAULT_LIFE_CONFIG: LifeConfig = {
  tzOffsetMinutes: 8 * 60,
  routine: DEFAULT_ROUTINE,
  quietGapMinutes: 180,
  maxReachOutsPerDay: 3,
  silentHours: { from: 0, to: 9 }
};

export interface ResolvedActivity {
  activity: string;
  kind: LifeKind;
  mood: string;
  /** Slot boundaries as absolute instants, so callers never redo the tz maths. */
  startedAt: Date;
  endsAt: Date;
}

/** Local calendar parts for an instant, without dragging in a tz library. */
function localParts(at: Date, tzOffsetMinutes: number): { dayIndex: number; hour: number; minute: number; dayStartUtcMs: number } {
  const shifted = new Date(at.getTime() + tzOffsetMinutes * 60_000);
  const dayIndex = Math.floor(shifted.getTime() / 86_400_000);
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  return { dayIndex, hour, minute, dayStartUtcMs: dayIndex * 86_400_000 - tzOffsetMinutes * 60_000 };
}

/**
 * Deterministic per day and slot: the same day resolves to the same activity
 * on every call, so a restart or a replayed tick never rewrites her past, but
 * consecutive days differ.
 */
function pick<T>(options: T[], dayIndex: number, slotIndex: number): T {
  const hash = Math.abs(Math.imul(dayIndex * 31 + slotIndex * 7 + 17, 2654435761)) % options.length;
  return options[hash]!;
}

export function resolveActivity(at: Date, config: LifeConfig = DEFAULT_LIFE_CONFIG): ResolvedActivity {
  const routine = [...config.routine].sort((a, b) => a.from - b.from);
  if (routine.length === 0) throw new Error('life routine is empty');
  const { dayIndex, hour, dayStartUtcMs } = localParts(at, config.tzOffsetMinutes);

  let index = 0;
  for (let i = 0; i < routine.length; i++) if (hour >= routine[i]!.from) index = i;
  const slot = routine[index]!;
  const next = routine[index + 1];

  // A slot that runs past midnight ends at the first slot of the next day.
  const startMs = dayStartUtcMs + slot.from * 3_600_000;
  const endMs = next ? dayStartUtcMs + next.from * 3_600_000 : dayStartUtcMs + 86_400_000 + routine[0]!.from * 3_600_000;

  return {
    activity: pick(slot.options, dayIndex, index),
    kind: slot.kind,
    mood: pick(slot.moods, dayIndex, index),
    startedAt: new Date(startMs),
    endsAt: new Date(endMs)
  };
}

export function isSilentHour(at: Date, config: LifeConfig = DEFAULT_LIFE_CONFIG): boolean {
  const { hour } = localParts(at, config.tzOffsetMinutes);
  const { from, to } = config.silentHours;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

function humanGap(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

export interface LifeTickResult {
  changed: boolean;
  activity: string;
  kind: LifeKind;
  mood: string;
  endedPrevious: LifeLogRow | null;
}

export class LifeEngine {
  constructor(
    private readonly repo: LifeRepo,
    private readonly config: LifeConfig = DEFAULT_LIFE_CONFIG,
    private readonly clock: () => Date = () => new Date()
  ) {}

  get settings(): LifeConfig {
    return this.config;
  }

  now(): Date {
    return this.clock();
  }

  /**
   * Moves her forward. Idempotent: called twice inside one slot the second
   * call changes nothing, so a 5-minute timer and a manual poke cannot produce
   * duplicate history.
   */
  tick(): LifeTickResult {
    const at = this.clock();
    const resolved = resolveActivity(at, this.config);
    const current = this.repo.current();
    if (current && current.activity === resolved.activity && current.started_at === resolved.startedAt.toISOString()) {
      return { changed: false, activity: current.activity, kind: current.kind as LifeKind, mood: current.mood, endedPrevious: null };
    }
    const { previous } = this.repo.advance({
      activity: resolved.activity,
      kind: resolved.kind,
      mood: resolved.mood,
      startedAt: resolved.startedAt.toISOString(),
      endsAt: resolved.endsAt.toISOString()
    });
    return { changed: true, activity: resolved.activity, kind: resolved.kind, mood: resolved.mood, endedPrevious: previous };
  }

  /** What she is doing right now, computed even if no tick has ever run. */
  currentActivity(): ResolvedActivity {
    return resolveActivity(this.clock(), this.config);
  }

  /**
   * The lines handed to the prompt. Deliberately factual: her own state, the
   * clock, and how long the user has been away. No instructions about tone --
   * that is the persona's job.
   */
  contextLines(lastUserMessageAt?: Date | null): string[] {
    const at = this.clock();
    const resolved = resolveActivity(at, this.config);
    const local = new Date(at.getTime() + this.config.tzOffsetMinutes * 60_000);
    const clock = `${local.getUTCMonth() + 1}月${local.getUTCDate()}日 ${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
    const intoIt = humanGap(at.getTime() - resolved.startedAt.getTime());

    const lines = [`现在是 ${clock}，你正在${resolved.activity}（已经 ${intoIt}），心情${resolved.mood}。`];

    const done = this.repo.recent(6).filter((row) => row.kind !== 'sleep').slice(0, 4);
    if (done.length > 0) {
      lines.push(`你今天先后：${done.slice().reverse().map((row) => row.activity).join('、')}。`);
    }
    if (lastUserMessageAt) {
      lines.push(`距离你们上次说话过了 ${humanGap(at.getTime() - lastUserMessageAt.getTime())}。`);
    }
    lines.push('这些是你真实的近况，被问起就照实说，不要临时编造别的活动。');
    return lines;
  }

  /**
   * Whether to speak first. Every condition is a reason not to bother the
   * user, so the default answer is no.
   */
  shouldReachOut(lastUserMessageAt: Date | null, lastAssistantMessageAt: Date | null): { reach: boolean; reason: string; candidate: LifeLogRow | null } {
    const at = this.clock();
    if (isSilentHour(at, this.config)) return { reach: false, reason: 'silent_hours', candidate: null };

    const resolved = resolveActivity(at, this.config);
    if (resolved.kind === 'sleep') return { reach: false, reason: 'asleep', candidate: null };

    const gapMs = this.config.quietGapMinutes * 60_000;
    if (lastUserMessageAt && at.getTime() - lastUserMessageAt.getTime() < gapMs) {
      return { reach: false, reason: 'user_was_recently_here', candidate: null };
    }
    // Do not stack unprompted messages when she already spoke last.
    if (lastAssistantMessageAt && (!lastUserMessageAt || lastAssistantMessageAt > lastUserMessageAt)
        && at.getTime() - lastAssistantMessageAt.getTime() < gapMs) {
      return { reach: false, reason: 'already_spoke', candidate: null };
    }
    const dayAgo = new Date(at.getTime() - 86_400_000).toISOString();
    if (this.repo.countSharedSince(dayAgo) >= this.config.maxReachOutsPerDay) {
      return { reach: false, reason: 'daily_cap', candidate: null };
    }
    const candidate = this.repo.unshared(['out', 'play', 'meal', 'chore'], 1)[0] ?? null;
    if (!candidate) return { reach: false, reason: 'nothing_worth_saying', candidate: null };
    return { reach: true, reason: 'ok', candidate };
  }

  markShared(id: string): void {
    this.repo.markShared([id]);
  }

  /** Current state for the UI, so the user can see what she is up to. */
  snapshot(): { activity: string; kind: LifeKind; mood: string; startedAt: string; endsAt: string; recent: Array<{ activity: string; startedAt: string; endedAt: string }> } {
    const resolved = resolveActivity(this.clock(), this.config);
    return {
      activity: resolved.activity,
      kind: resolved.kind,
      mood: resolved.mood,
      startedAt: resolved.startedAt.toISOString(),
      endsAt: resolved.endsAt.toISOString(),
      recent: this.repo.recent(8).map((row) => ({ activity: row.activity, startedAt: row.started_at, endedAt: row.ended_at }))
    };
  }
}
