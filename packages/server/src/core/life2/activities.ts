import type { LifeV2Repo } from '../../db/repos/life-v2.repo.js';
import type { LifeVitals } from './vitals.js';

/**
 * Activity library + scoring (§42-43) and the anti-repeat system (§44).
 * Rule-driven: the engine picks by score, not by template cycling.
 */

import type { LifeKind } from '../life.js';
import type { WeatherForecastSummary, DaylightSnapshot } from '../weather/forecast.js';
import { severeWithinHours } from '../weather/forecast.js';
export type { LifeKind };

export interface LifeActivityDefinition {
  id: string;
  titleTemplates: string[];
  kind: LifeKind;
  tags: string[];
  minDurationMinutes: number;
  maxDurationMinutes: number;
  allowedTimeRanges?: Array<[number, number]>;
  requiredVitals?: Partial<Record<keyof LifeVitals, [number, number]>>;
  baseWeight: number;
  cooldownHours: number;
  maxConsecutiveDays: number;
  effects: Partial<LifeVitals>;
  possibleOutcomes: string[];
  followUpHooks: string[];
  /** Preferred location kinds for this activity (next-phase location model). */
  locationAffinity?: string[];
  shareability: number;
}

export const ACTIVITY_LIBRARY: LifeActivityDefinition[] = [
  { id: 'cook', kind: 'meal', titleTemplates: ['做晚饭', '煮一碗面', '尝试一个新菜谱', '热了杯牛奶配吐司'], tags: ['cooking', 'home', 'food'], minDurationMinutes: 20, maxDurationMinutes: 60, allowedTimeRanges: [[7, 9], [11, 13], [17, 20]], baseWeight: 30, cooldownHours: 3, maxConsecutiveDays: 3, effects: { hunger: -45, energy: 8, comfort: 6 }, possibleOutcomes: ['cooked', 'slightly_failed'], followUpHooks: ['cleanup', 'read'], shareability: 0.5 },
  { id: 'eat', kind: 'meal', titleTemplates: ['吃午饭', '吃点东西垫垫肚子', '啃了个水果'], tags: ['food', 'home'], minDurationMinutes: 15, maxDurationMinutes: 40, allowedTimeRanges: [[7, 22]], baseWeight: 20, cooldownHours: 2, maxConsecutiveDays: 5, effects: { hunger: -35, energy: 5 }, possibleOutcomes: ['normal'], followUpHooks: [], shareability: 0.15 },
  { id: 'nap', kind: 'rest', titleTemplates: ['午睡一会儿', '躺着闭目养神', '窝在沙发上打盹'], tags: ['rest', 'home'], minDurationMinutes: 20, maxDurationMinutes: 90, allowedTimeRanges: [[12, 16]], baseWeight: 18, cooldownHours: 4, maxConsecutiveDays: 3, effects: { energy: 14, stress: -6, focus: 4 }, possibleOutcomes: ['normal', 'overslept'], followUpHooks: ['wake'], shareability: 0.1 },
  { id: 'rest', kind: 'rest', titleTemplates: ['休息一下', '发一会儿呆', '躺着刷手机'], tags: ['rest', 'home', 'solo'], minDurationMinutes: 10, maxDurationMinutes: 40, baseWeight: 15, cooldownHours: 2, maxConsecutiveDays: 4, effects: { energy: 9, stress: -5 }, possibleOutcomes: ['normal'], followUpHooks: [], shareability: 0.1 },
  { id: 'reading', kind: 'play', titleTemplates: ['看小说', '继续读昨天那本书', '翻几页漫画'], tags: ['reading', 'home', 'solo'], minDurationMinutes: 20, maxDurationMinutes: 120, baseWeight: 22, cooldownHours: 2, maxConsecutiveDays: 4, effects: { curiosity: 6, comfort: 6, energy: -3 }, possibleOutcomes: ['normal', 'plot_twist', 'lost_track'], followUpHooks: ['share_quote'], shareability: 0.45 },
  { id: 'gaming', kind: 'play', titleTemplates: ['打游戏', '玩了一会儿游戏'], tags: ['gaming', 'home', 'solo'], minDurationMinutes: 30, maxDurationMinutes: 180, baseWeight: 20, cooldownHours: 2, maxConsecutiveDays: 5, effects: { stress: -8, curiosity: 4, energy: -4 }, possibleOutcomes: ['normal', 'frustrating', 'fun_session'], followUpHooks: [], shareability: 0.4 },
  { id: 'music', kind: 'play', titleTemplates: ['练琴', '弹了一会儿琴', '听歌发呆'], tags: ['music', 'home', 'solo'], minDurationMinutes: 20, maxDurationMinutes: 90, baseWeight: 20, cooldownHours: 3, maxConsecutiveDays: 3, effects: { comfort: 8, stress: -6, energy: -3 }, possibleOutcomes: ['progress', 'stuck'], followUpHooks: [], shareability: 0.5 },
  { id: 'craft', kind: 'play', titleTemplates: ['画画', '拼乐高', '做点小手工'], tags: ['craft', 'home', 'solo'], minDurationMinutes: 25, maxDurationMinutes: 120, baseWeight: 18, cooldownHours: 4, maxConsecutiveDays: 3, effects: { focus: 7, comfort: 6, energy: -4 }, possibleOutcomes: ['progress', 'normal'], followUpHooks: [], shareability: 0.5 },
  { id: 'walk', kind: 'out', titleTemplates: ['出门散步', '去公园走一圈', '沿街溜达'], tags: ['walk', 'outdoors'], minDurationMinutes: 20, maxDurationMinutes: 80, allowedTimeRanges: [[8, 21]], baseWeight: 24, cooldownHours: 3, maxConsecutiveDays: 3, effects: { social_need: -8, loneliness: -10, curiosity: 8, energy: -6, stress: -4 }, possibleOutcomes: ['pleasant', 'normal', 'weather'], followUpHooks: ['shop', 'cafe'], shareability: 0.55 },
  { id: 'cafe', kind: 'out', titleTemplates: ['去咖啡店坐一会儿', '买杯拿铁看街景'], tags: ['cafe', 'out', 'drink', 'solo'], minDurationMinutes: 30, maxDurationMinutes: 120, allowedTimeRanges: [[9, 20]], baseWeight: 20, cooldownHours: 8, maxConsecutiveDays: 2, effects: { comfort: 7, social_need: -6, loneliness: -8, energy: 4 }, possibleOutcomes: ['normal', 'pleasant'], followUpHooks: ['reading'], shareability: 0.5 },
  { id: 'shopping', kind: 'out', titleTemplates: ['去超市买菜', '逛了趟超市', '顺路买点东西'], tags: ['shopping', 'out', 'errand'], minDurationMinutes: 30, maxDurationMinutes: 90, allowedTimeRanges: [[9, 21]], baseWeight: 20, cooldownHours: 6, maxConsecutiveDays: 2, effects: { hunger: -8, comfort: 5, energy: -7 }, possibleOutcomes: ['normal', 'bought_snack'], followUpHooks: ['cook', 'organize'], shareability: 0.45 },
  { id: 'organize', kind: 'chore', titleTemplates: ['收拾房间', '整理书桌', '给房间换个布置'], tags: ['chore', 'home', 'organize'], minDurationMinutes: 20, maxDurationMinutes: 90, baseWeight: 20, cooldownHours: 5, maxConsecutiveDays: 2, effects: { comfort: 10, focus: 5, energy: -8 }, possibleOutcomes: ['normal', 'pleasant', 'found_thing'], followUpHooks: [], shareability: 0.5 },
  { id: 'laundry', kind: 'chore', titleTemplates: ['洗衣服', '晒被子', '叠衣服'], tags: ['chore', 'home'], minDurationMinutes: 15, maxDurationMinutes: 40, baseWeight: 16, cooldownHours: 8, maxConsecutiveDays: 2, effects: { comfort: 6, energy: -5 }, possibleOutcomes: ['normal'], followUpHooks: [], shareability: 0.2 },
  { id: 'cleaning', kind: 'chore', titleTemplates: ['打扫卫生', '拖地', '擦桌子'], tags: ['chore', 'home', 'cleaning'], minDurationMinutes: 15, maxDurationMinutes: 60, baseWeight: 15, cooldownHours: 6, maxConsecutiveDays: 2, effects: { comfort: 9, energy: -7 }, possibleOutcomes: ['normal'], followUpHooks: [], shareability: 0.2 },
  { id: 'shower', kind: 'wind_down', titleTemplates: ['洗个澡', '敷面膜', '洗漱'], tags: ['selfcare', 'home'], minDurationMinutes: 10, maxDurationMinutes: 30, allowedTimeRanges: [[7, 24]], baseWeight: 22, cooldownHours: 6, maxConsecutiveDays: 3, effects: { comfort: 10, stress: -5, energy: 3 }, possibleOutcomes: ['normal', 'pleasant'], followUpHooks: [], shareability: 0.1 },
  { id: 'garden', kind: 'play', titleTemplates: ['给花浇水', '看看花盆新长的芽', '打理阳台的绿植'], tags: ['garden', 'home'], minDurationMinutes: 10, maxDurationMinutes: 40, baseWeight: 12, cooldownHours: 6, maxConsecutiveDays: 3, effects: { comfort: 6, curiosity: 3 }, possibleOutcomes: ['normal', 'new_sprout'], followUpHooks: [], shareability: 0.55 },
  { id: 'study', kind: 'study', titleTemplates: ['学了一会儿东西', '看教程', '练习'], tags: ['study', 'home', 'solo'], minDurationMinutes: 20, maxDurationMinutes: 90, baseWeight: 18, cooldownHours: 4, maxConsecutiveDays: 3, effects: { focus: 9, curiosity: 5, energy: -8, stress: 3 }, possibleOutcomes: ['progress', 'stuck', 'normal'], followUpHooks: ['practice'], shareability: 0.35 },
  { id: 'work', kind: 'work', titleTemplates: ['处理积压的事情', '写东西', '整理资料'], tags: ['work', 'home', 'solo'], minDurationMinutes: 30, maxDurationMinutes: 150, baseWeight: 16, cooldownHours: 4, maxConsecutiveDays: 2, effects: { focus: 7, stress: 4, energy: -10 }, possibleOutcomes: ['progress', 'normal'], followUpHooks: [], shareability: 0.3 }
];

const OUTCOME_POOLS: Record<string, string[]> = {
  normal: ['顺利做完了，没什么特别的。', '做完之后觉得挺踏实。'],
  pleasant: ['比想象中舒服，心情也跟着好了。', '过程很愉快，想记下来。'],
  disappointing: ['结果一般，有点小失落，不过也没太在意。', '不太顺利，但说不上糟。'],
  interrupted: ['做到一半被打断了，先放一放。'],
  failed: ['完全没做成，有点郁闷。'],
  surprising: ['有个意外的小惊喜。', '跟预想的不太一样，还挺有趣。'],
  progress: ['比上次顺了一点，有进展。', '卡了一阵，不过最后还是有点进展。'],
  stuck: ['卡住了，暂时没头绪。'],
  overslept: ['本来只想眯一会儿，结果睡过头了。'],
  plot_twist: ['看到一个很意外的转折，忍不住又多看了两章。'],
  lost_track: ['本来只想看十分钟，结果看入迷了。'],
  frustrating: ['玩得有点上头，输得莫名其妙。'],
  fun_session: ['手感很好，玩得挺开心。'],
  bought_snack: ['顺手买了一小袋零食，没忍住。'],
  found_thing: ['翻出来一件以为丢了的东西。'],
  new_sprout: ['花盆里长了一片新叶子。'],
  weather: ['风有点大，走了一会儿就回来了。'],
  cooked: ['做出来还不错，比想象中顺利。'],
  slightly_failed: ['面煮得有点软，不过调的酱汁还不错。']
};

export function outcomeFor(tag: string): string {
  return OUTCOME_POOLS[tag]?.[0] ?? OUTCOME_POOLS.normal![0]!;
}

export function outcomeDetailTags(definition: LifeActivityDefinition, outcomeTag: string): string[] {
  return [...definition.tags, outcomeTag];
}

export interface ScoreContext {
  vitals: LifeVitals;
  hour: number;
  dayIndex: number;
  slotIndex: number;
  usage: LifeV2Repo;
  themeTags: string[];
  threadFitIds: Set<string>;
  continuityFrom: string[];
  /** Next phase: cached weather condition (rain/snow/...) modifier. */
  weatherCondition?: string | null;
  /** Next phase: very hot (>=33C) suppresses midday outdoor activities. */
  weatherHot?: boolean;
  /**
   * Next phase: forecast summary — 未来 2 小时内有 severe（暴雨/暴风等）
   * 时长时间户外减分。天气仍是多因素评分的一部分，不是硬规则。
   */
  forecast?: WeatherForecastSummary | null;
  /** Next phase: daylight — 日落后的傍晚散步获得小幅加分。 */
  daylight?: DaylightSnapshot | null;
  /** Experiment knob: continuity bonus multiplier (default 1). */
  continuityWeight?: number;
  /** Experiment knob: exact-repeat tiers in hours (default [24,72,168]). */
  antiRepeatTiers?: [number, number, number];
}

/** Tags overlap penalty (§44.3) against the last few used activities. */
export function semanticRepeatPenalty(repo: LifeV2Repo, candidate: LifeActivityDefinition, window = 4): number {
  const recent = recentUsages(repo, window);
  if (recent.length === 0) return 0;
  const candidateTags = new Set(candidate.tags);
  let maxOverlap = 0;
  for (const tags of recent) {
    if (tags.length === 0) continue;
    const overlap = tags.filter((t) => candidateTags.has(t)).length;
    const union = new Set([...tags, ...candidateTags]).size;
    maxOverlap = Math.max(maxOverlap, overlap / Math.max(1, union));
  }
  return Math.round(maxOverlap * 30 * 100) / 100;
}

export function exactRepeatPenalty(repo: LifeV2Repo, candidate: LifeActivityDefinition, nowIso: string, tiers: [number, number, number] = [24, 72, 168]): number {
  const usage = repo.getUsage(candidate.id);
  if (!usage?.last_used_at) return 0;
  const hours = (Date.parse(nowIso) - Date.parse(usage.last_used_at)) / 3_600_000;
  if (hours < tiers[0]) return 60;
  if (hours < tiers[1]) return 30;
  if (hours < tiers[2]) return 10;
  return 0;
}

export function recentUsages(repo: LifeV2Repo, limit: number): string[][] {
  // The repo keeps one row per activity id; approximate the last-used order
  // by reading the most recently updated rows.
  return repo.recentActivityUsage(limit).map((row) => JSON.parse(row.semantic_tags_json) as string[]);
}

/** Total score for a candidate (§43). */
export function scoreActivity(def: LifeActivityDefinition, ctx: ScoreContext, nowIso: string): number {
  let score = def.baseWeight;

  // Time fit
  const inRange = !def.allowedTimeRanges?.length || def.allowedTimeRanges.some(([from, to]) => ctx.hour >= from && ctx.hour < to);
  score += inRange ? 12 : -25;

  // Vital need fit
  const v = ctx.vitals;
  if (def.kind === 'meal') score += mapRange(v.hunger, 45, 100, 0, 38);
  if (def.kind === 'rest' || def.kind === 'sleep') score += mapRange(100 - v.energy, 40, 100, 0, 32);
  if (def.kind === 'out') score += mapRange(v.social_need + v.loneliness, 50, 160, 0, 24);
  if (def.kind === 'play') score += mapRange(v.curiosity, 45, 100, 0, 16);
  if (def.kind === 'work' || def.kind === 'study') score += mapRange(v.focus, 45, 100, 0, 12) - Math.max(0, 60 - v.energy) / 4;

  // Weather modifier (next phase): rain/snow/storm suppress outdoor and
  // favour cozy/library; clear favours parks and walks; heat suppresses
  // midday outdoor. Modifiers only — vitals + plan + thread still decide.
  const w = ctx.weatherCondition;
  if (w === 'rain' || w === 'storm') {
    if (def.kind === 'out') score -= 30;
    if (def.tags.some((t) => t === 'cafe' || t === 'library' || t === 'home' || t === 'cozy')) score += 12;
  } else if (w === 'snow') {
    if (def.kind === 'out') score -= 25;
    if (def.tags.some((t) => t === 'home' || t === 'cozy')) score += 8;
  } else if (w === 'clear') {
    if (def.tags.some((t) => t === 'park' || t === 'walk' || t === 'out')) score += 15;
  }
  if (ctx.weatherHot && def.kind === 'out' && ctx.hour >= 11 && ctx.hour <= 15) score -= 25;

  // Forecast modifier (next phase): severe weather (暴雨/暴风等) within the
  // next 2 hours suppresses long outdoor windows. A modifier among many —
  // vitals + plan + thread still decide. 不制造夸张情绪。
  if (ctx.forecast && severeWithinHours(ctx.forecast, nowIso, 2) && def.kind === 'out' && def.minDurationMinutes >= 20) {
    score -= 20;
  }

  // Daylight modifier (next phase): 日落后的傍晚散步是自然的放松收尾，
  // 小幅加分；只影响 walk，且不跨深夜（散步窗口本身 8-21 点）。
  if (ctx.daylight && !ctx.daylight.isDaylight && def.id === 'walk' && ctx.hour >= 17 && ctx.hour < 22) {
    score += 10;
  }

  // Continuity bonus (§43.3 / E6): the previous activity's follow-up hooks
  // (买菜 → 做饭), its tags, its outcome tags, or an open thread's related
  // activities all raise the score of the natural next step. The weight is an
  // experiment knob (single-user A/B).
  const continuityWeight = ctx.continuityWeight ?? 1;
  for (const prev of ctx.continuityFrom) {
    if (prev === def.id || def.followUpHooks.includes(prev) || def.tags.some((t) => t === prev)) {
      score += 12 * continuityWeight;
      break;
    }
  }

  // Theme fit
  for (const tag of def.tags) if (ctx.themeTags.includes(tag)) score += 6;

  // Thread fit
  if (ctx.threadFitIds.has(def.id)) score += 14;

  // Anti-repeat (tiers are an experiment knob)
  score -= exactRepeatPenalty(ctx.usage, def, nowIso, ctx.antiRepeatTiers);
  score -= semanticRepeatPenalty(ctx.usage, def);

  // Controlled randomness (§43.4): only breaks near-ties.
  let hash = Math.imul(ctx.dayIndex + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(ctx.slotIndex * 31 + def.id.length, 0xc2b2ae35);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491);
  hash ^= hash >>> 13;
  score += (Math.abs(hash) % 17) - 8;
  return Math.round(score);
}

function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (value <= inMin) return outMin;
  if (value >= inMax) return outMax;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

export function defById(id: string): LifeActivityDefinition | undefined {
  return ACTIVITY_LIBRARY.find((d) => d.id === id);
}

export function pickTitle(def: LifeActivityDefinition, dayIndex: number, seed: number): string {
  const options = def.titleTemplates;
  let hash = Math.imul(dayIndex + seed * 7, 0x9e3779b9) ^ Math.imul(seed + 3, 0x85ebca6b);
  hash ^= hash >>> 13;
  return options[Math.abs(hash) % options.length]!;
}

export function durationFor(def: LifeActivityDefinition, seed: number): number {
  const span = def.maxDurationMinutes - def.minDurationMinutes;
  let hash = Math.imul(seed + 11, 0x2545f491);
  hash ^= hash >>> 13;
  return def.minDurationMinutes + (Math.abs(hash) % (span + 1));
}
