import type { LifeRepo, LifeLogRow, LifePlanRow, LifeEventRow } from '../../db/repos/life.repo.js';
import { LifeV2Repo, type LifeDayThemeRow, type LifeShareCandidateRow, type LifeThreadRow } from '../../db/repos/life-v2.repo.js';
import { resolveActivity, isSilentHour, DEFAULT_LIFE_CONFIG, type LifeConfig, type ResolvedActivity } from '../life.js';
import { LifeVitalsEngine, KIND_VITAL_EFFECTS } from './vitals.js';
import type { LifeVitalsRow } from '../../db/repos/life-v2.repo.js';
import { localDateOfIso, localDateTimeToUtc, timeZoneOffsetMinutes, weekdayOfLocalDate, zonedParts } from '../../util/time-zone.js';
import {
  ACTIVITY_LIBRARY,
  defById,
  scoreActivity,
  pickTitle,
  durationFor,
  outcomeFor,
  outcomeDetailTags,
  type LifeActivityDefinition
} from './activities.js';

export type { LifeKind } from '../life.js';

export interface LifeSimResult {
  changed: boolean;
  activity: string;
  kind: string;
  mood: string;
  endedPrevious: LifeLogRow | null;
}

/** Local calendar parts (mirrors life.ts internals without exporting them). */
function localParts(
  at: Date,
  tzOffsetMinutes: number,
  timeZone?: string
): { dayIndex: number; hour: number; minute: number; dayStartMs: number; localDate: string } {
  if (timeZone) {
    try {
      const parts = zonedParts(at, timeZone);
      const offset = timeZoneOffsetMinutesSafe(at, timeZone, tzOffsetMinutes);
      const dayIndex = Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
      return {
        dayIndex,
        hour: parts.hour,
        minute: parts.minute,
        dayStartMs: Date.UTC(parts.year, parts.month - 1, parts.day) - offset * 60_000,
        localDate: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
      };
    } catch { /* fall back to the legacy offset below */ }
  }
  const shifted = new Date(at.getTime() + tzOffsetMinutes * 60_000);
  const dayIndex = Math.floor(shifted.getTime() / 86_400_000);
  return {
    dayIndex,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    dayStartMs: dayIndex * 86_400_000 - tzOffsetMinutes * 60_000,
    localDate: shifted.toISOString().slice(0, 10)
  };
}

function timeZoneOffsetMinutesSafe(at: Date, timeZone: string, fallback: number): number {
  try {
    return timeZoneOffsetMinutes(at, timeZone);
  } catch {
    return fallback;
  }
}

const THEME_POOL: Array<{ theme: string; toneTags: string[]; planIds: string[] }> = [
  { theme: '整理生活日', toneTags: ['chore', 'home', 'organize'], planIds: ['organize', 'laundry', 'cleaning'] },
  { theme: '轻松宅家日', toneTags: ['home', 'rest', 'cozy'], planIds: ['reading', 'gaming', 'cook'] },
  { theme: '恢复精力日', toneTags: ['rest', 'selfcare'], planIds: ['rest', 'shower', 'nap'] },
  { theme: '探索附近日', toneTags: ['out', 'curious'], planIds: ['walk', 'cafe', 'shopping'] },
  { theme: '专注创作日', toneTags: ['craft', 'focus', 'music'], planIds: ['craft', 'music', 'study'] },
  { theme: '处理积压事项日', toneTags: ['work', 'chore'], planIds: ['work', 'organize', 'study'] },
  { theme: '想尝试新东西的一天', toneTags: ['novel', 'out'], planIds: ['walk', 'cafe', 'cook'] },
  { theme: '阴雨慢节奏日', toneTags: ['home', 'slow', 'rest'], planIds: ['reading', 'cook', 'gaming'] }
];

/** Kinds whose completion is traditionally worth mentioning unprompted. */
const SHAREABLE_KINDS = new Set(['out', 'play', 'meal', 'chore']);

const MOOD_BY_KIND: Record<string, string[]> = {
  sleep: ['安静', '睡着'],
  wake: ['迷糊', '慢慢清醒'],
  meal: ['满足', '有点饿'],
  rest: ['懒', '放松'],
  play: ['专注', '开心'],
  out: ['轻快', '好奇'],
  chore: ['勤快', '哼着歌'],
  wind_down: ['困', '舒服'],
  work: ['认真'],
  study: ['专注']
};

function seededPick<T>(options: T[], seed: number): T {
  let h = Math.imul(seed + 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return options[Math.abs(h) % options.length]!;
}

/**
 * Life simulation engine v2 (Part 2): continuous vitals, day themes, scored
 * activities with anti-repeat, plan deviation, structured outcomes, threads,
 * incidents and share candidates. Keeps the public surface of the legacy
 * LifeEngine so proactive/tick/bootstrap wiring is unchanged.
 */
export class LifeSimEngine {
  readonly vitals: LifeVitalsEngine;
  private readonly resolve: () => LifeConfig;

  constructor(
    private readonly repo: LifeRepo,
    private readonly v2: LifeV2Repo,
    config: LifeConfig | (() => LifeConfig) = DEFAULT_LIFE_CONFIG,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.resolve = typeof config === 'function' ? config : () => config;
    this.vitals = new LifeVitalsEngine(v2, clock, repo);
  }

  get settings(): LifeConfig {
    return this.resolve();
  }

  now(): Date {
    return this.clock();
  }

  get tzOffset(): number {
    return this.settings.tzOffsetMinutes;
  }

  // ------------------------------------------------------------------ theme

  dayTheme(): LifeDayThemeRow {
    const parts = localParts(this.clock(), this.tzOffset, this.settings.timeZone);
    const existing = this.v2.themeFor(parts.localDate);
    if (existing) return existing;
    return this.rollTheme(parts);
  }

  private rollTheme(parts: { dayIndex: number; hour: number; localDate: string }): LifeDayThemeRow {
    const v = this.vitals.settle();
    const recent = this.v2.recentThemes(7).map((t) => t.theme);
    const weekday = weekdayOfLocalDate(parts.localDate);
    const isWeekend = weekday === 0 || weekday === 6;
    const candidates = [...THEME_POOL];
    const factors: string[] = [];
    if (v.sleep_debt > 4) { candidates.unshift(THEME_POOL[2]!); factors.push('高睡眠债'); }
    if (isWeekend && candidates.some((c) => c.theme.includes('探索'))) factors.push('周末');
    if (v.energy < 35) factors.push('低精力');
    // Cooldown: avoid the same theme within 7 days.
    const fresh = candidates.filter((c) => !recent.includes(c.theme));
    const pool = fresh.length > 0 ? fresh : candidates;
    const choice = seededPick(pool, parts.dayIndex * 13 + 5);
    const theme = this.v2.saveTheme({
      localDate: parts.localDate,
      theme: choice.theme,
      toneTags: choice.toneTags,
      sourceFactors: factors
    });
    this.generateDayPlans(theme, parts.dayIndex);
    return theme;
  }

  /** 2-3 plans from the theme pool; keeps conversation-sourced plans. */
  private generateDayPlans(theme: LifeDayThemeRow, dayIndex: number): void {
    const today = theme.local_date;
    const existing = this.repo.listPlans().filter((p) => isLocalDate(p.planned_start, today, this.tzOffset, this.settings.timeZone));
    if (existing.length >= 2) return;
    const pool = THEME_POOL.find((c) => c.theme === theme.theme) ?? THEME_POOL[0]!;
    const ids = pool.planIds;
    for (const id of ids) {
      if (existing.length >= 3) break;
      const def = defById(id);
      if (!def) continue;
      const hour = 9 + dayIndex % 9;
      const start = localDateTimeToUtc(today, hour, 0, this.settings.timeZone, this.tzOffset);
      this.repo.createPlan({
        title: pickTitle(def, dayIndex, hour),
        kind: def.kind,
        plannedStart: start.toISOString(),
        plannedEnd: new Date(start.getTime() + durationFor(def, hour) * 60_000).toISOString(),
        status: 'planned',
        source: 'generated',
        priority: 0.6,
        meta: { activityId: id, dayThemeId: theme.id, optional: true }
      });
    }
  }

  // ------------------------------------------------------------------- tick

  /**
   * Advances the simulation. Priority: ongoing activity → user plan due →
   * basic needs → thread action → scored activity → routine fallback.
   */
  tick(): LifeSimResult {
    const at = this.clock();
    const parts = localParts(at, this.tzOffset, this.settings.timeZone);
    const v = this.vitals.settle();
    const theme = this.dayTheme();
    const current = this.repo.current();
    const endedPrevious: LifeLogRow | null = null;

    // Ongoing activity: keep until its ends_at unless needs override.
    if (current && Date.parse(current.ends_at) > at.getTime() && current.kind !== 'sleep') {
      return { changed: false, activity: current.activity, kind: current.kind, mood: current.mood, endedPrevious };
    }

    const resolved = this.resolveNext(parts, v, theme);
    if (current && current.activity === resolved.activity && current.started_at === resolved.startedAt.toISOString()) {
      return { changed: false, activity: current.activity, kind: current.kind, mood: current.mood, endedPrevious };
    }

    // Leaving an activity: advance first so the filed log row exists, then
    // roll the outcome event linked to that log (markShared relies on the
    // event → log linkage to mark both shared).
    const advanced = this.repo.advance({
      activity: resolved.activity,
      kind: resolved.kind,
      mood: resolved.mood,
      startedAt: resolved.startedAt.toISOString(),
      endsAt: resolved.endsAt.toISOString(),
      meta: { source: resolved.source, activityId: resolved.activityId ?? null, planId: (resolved as { planId?: string }).planId ?? null }
    }, { recordCompletionEvent: false });
    if (current && current.kind !== 'sleep' && current.kind !== 'wake') {
      this.finishActivity(current, parts, advanced.previous?.id ?? null);
    }
    this.rollIncident(resolved, parts, theme);
    this.v2.expireShareCandidates();
    this.decayThreads();
    this.settlePlanWindows(parts);
    this.ensureSeedThreads();
    return { changed: true, activity: resolved.activity, kind: resolved.kind, mood: resolved.mood, endedPrevious: advanced.previous };
  }

  private resolveNext(
    parts: { dayIndex: number; hour: number; minute: number; dayStartMs: number; localDate: string },
    v: LifeVitalsRow,
    theme: LifeDayThemeRow
  ): ResolvedActivity & { source: string; activityId?: string | null; planId?: string | null } {
    const at = this.clock();

    // 1. Night sleep.
    if (parts.hour >= 23 || parts.hour < 7) return this.routineActivity(parts, at);
    // 2. Basic needs first.
    if (v.hunger > 72 && parts.hour >= 7 && parts.hour < 22) {
      return this.scored(parts, at, 'eat', 'need:hunger');
    }
    if (v.energy < 22 && parts.hour >= 12 && parts.hour < 18) {
      return this.scored(parts, at, 'nap', 'need:energy');
    }
    // 3. High-priority user plan due now.
    const duePlan = this.repo.listPlans('planned').find((p) => {
      if (p.source !== 'conversation') return false;
      const start = p.planned_start ? Date.parse(p.planned_start) : null;
      return start !== null && Math.abs(start - at.getTime()) < 2 * 3_600_000;
    });
    if (duePlan && duePlan.meta_json) {
      const meta = JSON.parse(duePlan.meta_json) as { activityId?: string; freeformIntent?: string };
      const def = meta.activityId ? defById(meta.activityId) : meta.freeformIntent ? this.matchActivity(meta.freeformIntent) : undefined;
      if (def) {
        this.repo.updatePlan(duePlan.id, { status: 'active', meta: { startedActivityId: def.id } });
        return this.scored(parts, at, def.id, 'plan:user', duePlan.id);
      }
      // 无法安全解析的活动保持 planned，不假装完成 (E2)。
    }
    // 4. Today's theme plan in its window.
    const todayPlans = this.repo.listPlans().filter((p) => isLocalDate(p.planned_start, parts.localDate, this.tzOffset, this.settings.timeZone) && p.status === 'planned');
    const windowPlan = todayPlans.find((p) => {
      const start = p.planned_start ? Date.parse(p.planned_start) : null;
      return start !== null && at.getTime() >= start - 15 * 60_000 && at.getTime() <= start + 75 * 60_000;
    });
    if (windowPlan) {
      const meta = JSON.parse(windowPlan.meta_json ?? '{}') as { activityId?: string };
      const def = defById(meta.activityId ?? '');
      if (def) {
        this.repo.updatePlan(windowPlan.id, { status: 'active' });
        return this.scored(parts, at, def.id, 'plan:theme', windowPlan.id);
      }
    }
    // 5. Scored free choice.
    const best = this.bestScored(parts, v, theme);
    if (best) return this.scored(parts, at, best, 'scored');
    // 6. Routine fallback.
    return this.routineActivity(parts, at);
  }

  private scored(
    parts: { dayIndex: number; hour: number; dayStartMs: number },
    at: Date,
    activityId: string,
    source: string,
    planId?: string
  ): ResolvedActivity & { source: string; activityId?: string | null; planId?: string | null } {
    const def = defById(activityId) ?? ACTIVITY_LIBRARY[0]!;
    const seed = parts.dayIndex * 31 + parts.hour;
    const startedAt = new Date(at.getTime());
    const minutes = durationFor(def, seed);
    const endsAt = new Date(startedAt.getTime() + minutes * 60_000);
    const moods = MOOD_BY_KIND[def.kind] ?? ['还行'];
    return {
      activity: pickTitle(def, parts.dayIndex, seed),
      kind: def.kind,
      mood: seededPick(moods, seed + 7),
      startedAt,
      endsAt,
      source,
      activityId: def.id,
      planId
    };
  }

  private routineActivity(parts: { dayIndex: number; hour: number; dayStartMs: number }, at: Date): ResolvedActivity & { source: string; activityId?: string | null } {
    const base = resolveActivity(at, this.settings);
    return { ...base, source: 'routine', activityId: null };
  }

  private bestScored(parts: { dayIndex: number; hour: number; dayStartMs: number }, v: LifeVitalsRow, theme: LifeDayThemeRow): string | null {
    const threads = this.v2.threads('open');
    const threadFitIds = new Set<string>();
    for (const t of threads) {
      const meta = JSON.parse(t.meta_json) as { relatedActivityIds?: string[] };
      for (const id of meta.relatedActivityIds ?? []) threadFitIds.add(id);
    }
    const themeTags = JSON.parse(theme.tone_tags_json) as string[];
    // E6: real causal context — previous activity's follow-up hooks and tags,
    // its outcome tags, and the open threads' related activities. 买菜 → 做饭
    // gets its bonus because shopping's follow-up hook ('cook') is a def id.
    const continuityFrom: string[] = [];
    const prevState = this.repo.current();
    if (prevState) {
      const prevMeta = safeMeta(prevState.meta_json);
      const prevDef = defById(String(prevMeta.activityId ?? ''));
      if (prevDef) continuityFrom.push(...prevDef.followUpHooks, ...prevDef.tags);
      const prevEvents = this.repo.events(1);
      if (prevEvents[0]) continuityFrom.push(...(outcomeDetailTagsFor(prevEvents[0], prevDef) ?? []));
    }
    for (const id of threadFitIds) continuityFrom.push(id);
    const ctx = {
      vitals: v,
      hour: parts.hour,
      dayIndex: parts.dayIndex,
      slotIndex: parts.hour,
      usage: this.v2,
      themeTags,
      threadFitIds,
      continuityFrom: [...new Set(continuityFrom)]
    };
    let best: LifeActivityDefinition | null = null;
    let bestScore = -Infinity;
    const nowIso = this.clock().toISOString();
    for (const def of ACTIVITY_LIBRARY) {
      if (def.kind === 'sleep' || def.kind === 'wake') continue;
      const score = scoreActivity(def, ctx, nowIso);
      if (score > bestScore) {
        bestScore = score;
        best = def;
      }
    }
    return best?.id ?? null;
  }

  private finishActivity(current: LifeRepoCurrent, parts: { dayIndex: number; hour: number }, logId: string | null = null): void {
    const meta = safeMeta(current.meta_json);
    const activityId = (meta.activityId as string | undefined) ?? '';
    const planId = (meta.planId as string | undefined) ?? null;
    const def = defById(activityId);
    const outcomeTag = def ? seededPick(def.possibleOutcomes, parts.dayIndex * 7 + parts.hour) : 'normal';
    const summary = outcomeFor(outcomeTag);
    const kind = current.kind;
    // Record the outcome as the single boundary event (the legacy
    // activity.completed is suppressed for V2), linked to its plan when one
    // drove it. Shareable when the outcome deserves it OR the kind is
    // traditionally share-worthy — the legacy heuristic stays a floor.
    const event = this.repo.recordEvent({
      eventType: 'activity.finished',
      activity: current.activity,
      kind,
      description: summary,
      moodBefore: current.mood,
      moodAfter: outcomeTag === 'disappointing' || outcomeTag === 'stuck' || outcomeTag === 'frustrating' ? '有点失落' : outcomeTag === 'pleasant' || outcomeTag === 'progress' || outcomeTag === 'fun_session' ? '心情不错' : null,
      happenedAt: this.clock().toISOString(),
      shareable: ((def?.shareability ?? 0) >= 0.45 && outcomeTag !== 'normal') || SHAREABLE_KINDS.has(kind),
      logId,
      planId,
      meta: { resultType: outcomeTag, magnitude: 'small', tags: def ? outcomeDetailTags(def, outcomeTag) : [kind] }
    });
    // E3: close the plan lifecycle — the activity that started a plan ends it.
    if (planId) {
      this.repo.updatePlan(planId, {
        status: 'completed',
        meta: { outcomeId: event.id, outcome: outcomeTag, completedAt: this.clock().toISOString() }
      });
    }
    if (def) {
      this.v2.recordUsage({ activityId: def.id, tags: def.tags, outcomeTags: [outcomeTag], usedAt: this.clock().toISOString() });
      // Thread advance when the activity belongs to an open thread.
      for (const thread of this.v2.threads('open')) {
        const tmeta = JSON.parse(thread.meta_json) as { relatedActivityIds?: string[] };
        if ((tmeta.relatedActivityIds ?? []).includes(def.id)) {
          this.v2.saveThread({
            id: thread.id,
            title: thread.title,
            category: thread.category,
            progress: Math.min(1, thread.progress + 0.15 + Math.random() * 0.1),
            heat: Math.min(1, thread.heat + 0.1),
            status: thread.progress >= 0.85 ? 'resolved' : thread.status,
            nextActions: JSON.parse(thread.next_actions_json)
          });
        }
      }
      // E4: an outcome with follow-up hooks opens a thread ("做完这件事，接着…").
      this.createFollowUpThread(def, outcomeTag);
      // Share candidate for good outcomes.
      if (def.shareability >= 0.45 && !['normal', 'disappointing', 'stuck', 'frustrating'].includes(outcomeTag)) {
        const nowIso = this.clock().toISOString();
        this.v2.addShareCandidate({
          sourceType: 'event',
          sourceId: event.id,
          novelty: outcomeTag === 'surprising' || outcomeTag === 'new_sprout' || outcomeTag === 'plot_twist' ? 0.7 : 0.45,
          relevanceToUser: def.shareability,
          emotionalValue: outcomeTag === 'pleasant' || outcomeTag === 'progress' ? 0.55 : 0.35,
          urgency: 0.1,
          repetitionPenalty: 0,
          expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
          meta: { activity: current.activity, summary, kind }
        });
      }
    } else {
      // E1: routine (non-library) activities still move the vitals through the
      // kind-level table instead of being free — sleeping now recovers energy.
      const kindEffect = KIND_VITAL_EFFECTS[kind];
      if (kindEffect) this.vitals.applyEffect(kindEffect);
    }
    // Vitals effect of the finished activity.
    if (def) this.vitals.applyEffect(def.effects);
  }

  private rollIncident(
    resolved: ResolvedActivity & { source: string; activityId?: string | null },
    parts: { dayIndex: number; hour: number },
    theme: LifeDayThemeRow
  ): void {
    // Conditional tiny incidents: ~18% per non-sleep transition.
    if (resolved.kind === 'sleep' || resolved.kind === 'wake') return;
    let hash = Math.imul(parts.dayIndex * 17 + parts.hour, 0x9e3779b9);
    hash ^= hash >>> 15;
    if (Math.abs(hash) % 100 >= 18) return;
    const pool = ['杯子里的水放凉了', '手机电量只剩一点', '外面光线暗下来了', '零食盒子空了', '把发圈随手放在桌上了'];
    const incident = seededPick(pool, parts.dayIndex * 3 + parts.hour);
    this.repo.recordEvent({
      eventType: 'incident.tiny',
      activity: resolved.activity,
      kind: resolved.kind,
      description: incident,
      happenedAt: this.clock().toISOString(),
      shareable: false,
      meta: { magnitude: 'tiny' }
    });
  }

  private decayThreads(): void {
    for (const t of this.v2.threads()) {
      const updated = Date.parse(t.updated_at);
      const hours = Math.max(0, (this.clock().getTime() - updated) / 3_600_000);
      if (hours > 6) {
        this.v2.saveThread({
          id: t.id,
          title: t.title,
          category: t.category,
          heat: Math.max(0.05, t.heat - hours * 0.004),
          status: t.status,
          nextActions: JSON.parse(t.next_actions_json)
        });
      }
    }
  }

  // ------------------------------------------------------------ conversation

  /** Extracts a user suggestion/plan from a completed exchange (§49.1). */
  extractConversationIntent(text: string, messageId: string): LifePlanRow | null {
    const t = (text ?? '').trim();
    if (!t) return null;
    const match = /(?:建议|推荐|可以试试|要不要去试试|要不要试|去试试|试试|你应该去|听说.{0,20}(?:好吃|好玩|不错))/u.exec(t);
    if (!match) return null;
    const target = t.slice(match.index).replace(/^[，,：:\s]+/u, '').slice(0, 40);
    if (target.length < 4) return null;
    const isOut = /店|馆|公园|散步|走|买|看|玩|吃/u.test(target);
    const start = new Date(Date.now() + 3 * 3_600_000);
    // E2: map the suggestion onto the activity library when possible, else
    // keep a constrained freeform intent; unresolvable plans stay planned.
    const mapped = this.matchActivity(target);
    const meta: Record<string, unknown> = {
      relatedMessageId: messageId,
      userSuggestion: true,
      freeformIntent: target,
      tags: mapped ? mapped.tags : []
    };
    if (mapped) meta.activityId = mapped.id;
    const plan = this.repo.createPlan({
      title: target,
      kind: mapped?.kind ?? (isOut ? 'out' : 'play'),
      plannedStart: start.toISOString(),
      plannedEnd: new Date(start.getTime() + 60 * 60_000).toISOString(),
      status: 'planned',
      source: 'conversation',
      priority: 0.75,
      meta
    });
    // E4: conversation suggestions also open a thread so the plan stays alive.
    this.createThreadFromSuggestion(target, mapped?.id ?? null, messageId);
    return plan;
  }

  applyConversationEffect(mood: 'warm' | 'neutral' | 'rough'): void {
    this.vitals.applyConversation(mood);
  }

  /**
   * Keyword matcher from a free-form phrase onto the activity library (E2).
   * Deterministic and cheap; a miss keeps the plan as freeformIntent.
   */
  private matchActivity(text: string): LifeActivityDefinition | null {
    const t = (text ?? '').toLowerCase();
    const rules: Array<[RegExp, string]> = [
      [/买菜|超市|采购|囤货|便利店/u, 'shopping'],
      [/散步|公园|遛|走走|出门走|压马路/u, 'walk'],
      [/咖啡|奶茶|拿铁|饮品|下午茶/u, 'cafe'],
      [/书|小说|漫画|杂志/u, 'reading'],
      [/游戏|打机|steam|switch|ps5/u, 'gaming'],
      [/琴|钢琴|吉他|音乐|唱歌/u, 'music'],
      [/画|素描|水彩|涂鸦/u, 'craft'],
      [/做饭|做饭菜|煮面|下厨|菜谱|晚饭|午饭|早餐|面|饭/u, 'cook'],
      [/学|教程|课|练习|复习|背/u, 'study'],
      [/澡|泡澡|洗漱/u, 'shower'],
      [/收拾|整理|打扫|清洁/u, 'organize'],
      [/洗衣|洗衣服|晒被子/u, 'laundry'],
      [/花|绿植|植物/u, 'garden'],
      [/电影|剧|追剧/u, 'reading']
    ];
    for (const [re, id] of rules) if (re.test(t)) return defById(id) ?? null;
    return null;
  }

  /** E4: a finished activity with follow-up hooks opens a thread (bounded). */
  private createFollowUpThread(def: LifeActivityDefinition, outcomeTag: string): void {
    if (def.followUpHooks.length === 0) return;
    if (this.v2.threads('open').length >= 3) return;
    const target = def.followUpHooks.map((id) => defById(id)).find((d) => d !== undefined);
    if (!target) return;
    this.v2.saveThread({
      title: `${def.titleTemplates[0]}之后，接着${target.titleTemplates[0] ?? '做点什么'}`,
      category: 'follow_up',
      status: 'open',
      progress: 0,
      importance: 0.4 + (outcomeTag === 'pleasant' || outcomeTag === 'progress' ? 0.2 : 0),
      heat: 0.35,
      nextActions: target.titleTemplates.slice(0, 3),
      meta: { relatedActivityIds: [target.id], source: 'activity_outcome' }
    });
  }

  /** E4: a conversation suggestion opens a thread too (bounded). */
  private createThreadFromSuggestion(target: string, activityId: string | null, messageId: string): void {
    if (this.v2.threads('open').length >= 3) return;
    this.v2.saveThread({
      title: `把「${target.slice(0, 16)}」安排上`,
      category: 'conversation',
      status: 'open',
      progress: 0,
      importance: 0.5,
      heat: 0.4,
      nextActions: activityId ? (defById(activityId)?.titleTemplates.slice(0, 3) ?? []) : ['找个合适的时间去做'],
      meta: { relatedActivityIds: activityId ? [activityId] : [], source: 'conversation', sourceMessageId: messageId }
    });
  }

  /** E4: seed a couple of persona-flavoured interest threads once (bounded). */
  private ensureSeedThreads(): void {
    if (this.v2.threads().length > 0) return;
    const seeds: Array<[string, string]> = [
      ['画画', 'craft'],
      ['练琴', 'music'],
      ['看书', 'reading'],
      ['养绿植', 'garden']
    ];
    for (const [title, id] of seeds) {
      const def = defById(id);
      if (!def) continue;
      this.v2.saveThread({
        title: `${title}，慢慢练起来`,
        category: 'interest',
        status: 'open',
        progress: 0.1,
        importance: 0.3,
        heat: 0.3,
        nextActions: def.titleTemplates.slice(0, 3),
        meta: { relatedActivityIds: [def.id], source: 'persona_seed' }
      });
    }
  }

  /** E3: plans whose window passed without starting are closed as skipped. */
  private settlePlanWindows(parts: { dayIndex: number; hour: number; localDate: string }): void {
    const at = this.clock().getTime();
    for (const plan of this.repo.listPlans('planned')) {
      if (!plan.planned_start) continue;
      const startMs = Date.parse(plan.planned_start);
      if (at - startMs > 75 * 60_000) {
        this.repo.updatePlan(plan.id, { status: 'skipped', meta: { skippedAt: new Date(at).toISOString() } });
      }
    }
  }

  // ------------------------------------------------------------ context

  contextLines(lastUserMessageAt?: Date | null): string[] {
    const at = this.clock();
    const parts = localParts(at, this.tzOffset, this.settings.timeZone);
    const current = this.repo.current();
    const v = this.vitals.settle();
    const theme = this.dayTheme();
    const lines: string[] = [];
    const clockStr = `${parts.localDate.slice(5)} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    lines.push(`现在是 ${clockStr}。`);
    if (current) {
      const minutes = Math.max(0, Math.round((at.getTime() - Date.parse(current.started_at)) / 60_000));
      lines.push(`你正在${current.activity}，已经进行了约 ${minutes} 分钟，心情${current.mood}。`);
    }
    lines.push(`今天的主题是「${theme.theme}」。`);
    const vitalsSummary = this.vitals.summary(v);
    if (vitalsSummary.length) lines.push(`身体状态：${vitalsSummary.join('，')}。`);
    const todayPlans = this.repo.listPlans().filter((p) => isLocalDate(p.planned_start, parts.localDate, this.tzOffset, this.settings.timeZone));
    const pending = todayPlans.filter((p) => p.status === 'planned' || p.status === 'active').slice(0, 3);
    if (pending.length) lines.push(`今天计划：${pending.map((p) => p.title).join('；')}。`);
    const recentEvents = this.repo.events(3);
    if (recentEvents.length) lines.push(`最近：${recentEvents.map((e) => e.description).join('；')}。`);
    const threads = this.v2.threads('open').slice(0, 2);
    for (const t of threads) {
      lines.push(`正在推进「${t.title}」，进度约 ${Math.round(t.progress * 100)}%。`);
    }
    const userPlans = this.repo.listPlans().filter((p) => p.source === 'conversation' && (p.status === 'planned' || p.status === 'active'));
    if (userPlans.length) {
      lines.push(`你之前建议的「${userPlans[0]!.title}」还只是计划，还没有发生。`);
    }
    lines.push('这些是你真实的近况，被问起就照实说，不要临时编造别的活动。');
    return lines;
  }

  // ------------------------------------------------------------- proactive

  shouldReachOut(lastUserMessageAt: Date | null, lastAssistantMessageAt: Date | null): { reach: boolean; reason: string; candidate: LifeLogRow | null } {
    const at = this.clock();
    if (!this.settings.reachOut) return { reach: false, reason: 'disabled', candidate: null };
    if (this.settings.maxReachOutsPerDay <= 0) return { reach: false, reason: 'daily_cap', candidate: null };
    if (isSilentHour(at, this.settings)) return { reach: false, reason: 'silent_hours', candidate: null };

    const gapMs = this.settings.quietGapMinutes * 60_000;
    if (lastUserMessageAt && at.getTime() - lastUserMessageAt.getTime() < gapMs) {
      return { reach: false, reason: 'user_was_recently_here', candidate: null };
    }
    if (lastAssistantMessageAt && (!lastUserMessageAt || lastAssistantMessageAt > lastUserMessageAt)
        && at.getTime() - lastAssistantMessageAt.getTime() < gapMs) {
      return { reach: false, reason: 'already_spoke', candidate: null };
    }
    const dayAgo = new Date(at.getTime() - 86_400_000).toISOString();
    if (this.repo.countSharedSince(dayAgo) >= this.settings.maxReachOutsPerDay) {
      return { reach: false, reason: 'daily_cap', candidate: null };
    }
    // Prefer scored share candidates over the legacy unshared log.
    const candidates = this.v2.pendingCandidates();
    if (candidates.length > 0) {
      const best = candidates[0]!;
      const meta = safeMeta(best.meta_json);
      const candidate: LifeLogRow = {
        id: best.id,
        activity: String(meta.activity ?? ''),
        kind: String(meta.kind ?? 'play'),
        mood: '开心',
        started_at: best.created_at,
        ended_at: best.expires_at,
        shared: 0,
        created_at: best.created_at
      };
      return { reach: true, reason: 'share_candidate', candidate };
    }
    const event = this.repo.unsharedEvents(1)[0];
    const candidate: LifeLogRow | null = event
      ? {
          id: event.id,
          activity: event.activity,
          kind: event.kind,
          mood: event.mood_after ?? event.mood_before ?? '',
          started_at: event.happened_at,
          ended_at: event.happened_at,
          shared: 0,
          created_at: event.created_at
        }
      : this.repo.unshared(['out', 'play', 'meal', 'chore'], 1)[0] ?? null;
    if (!candidate) return { reach: false, reason: 'nothing_worth_saying', candidate: null };
    return { reach: true, reason: 'ok', candidate };
  }

  markShared(id: string): void {
    this.v2.updateShareCandidate(id, { status: 'shared', shared_at: new Date().toISOString() });
    this.v2.markSharedBySource('event', id);
    this.repo.markShared([id]);
  }

  // ------------------------------------------------------------- snapshot

  snapshot(): {
    activity: string; kind: string; mood: string; startedAt: string; endsAt: string;
    recent: Array<{ activity: string; startedAt: string; endedAt: string }>;
    theme?: string; vitals?: string[]; plans?: Array<{ title: string; status: string }>; threads?: Array<{ title: string; progress: number }>;
  } {
    const resolved = resolveActivity(this.clock(), this.settings);
    const current = this.repo.current();
    const v = this.vitals.settle();
    const theme = this.dayTheme();
    const parts = localParts(this.clock(), this.tzOffset, this.settings.timeZone);
    const todayPlans = this.repo.listPlans().filter((p) => isLocalDate(p.planned_start, parts.localDate, this.tzOffset, this.settings.timeZone));
    return {
      activity: current?.activity ?? resolved.activity,
      kind: current?.kind ?? resolved.kind,
      mood: current?.mood ?? resolved.mood,
      startedAt: current?.started_at ?? resolved.startedAt.toISOString(),
      endsAt: current?.ends_at ?? resolved.endsAt.toISOString(),
      recent: this.repo.recent(8).map((row) => ({ activity: row.activity, startedAt: row.started_at, endedAt: row.ended_at })),
      theme: theme.theme,
      vitals: this.vitals.summary(v),
      plans: todayPlans.slice(0, 5).map((p) => ({ title: p.title, status: p.status })),
      threads: this.v2.threads('open').slice(0, 3).map((t) => ({ title: t.title, progress: Math.round(t.progress * 100) }))
    };
  }
}

type LifeRepoCurrent = NonNullable<ReturnType<LifeRepo['current']>>;

function safeMeta(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}

/** E5: is the plan's start instant on the given local calendar date? */
function isLocalDate(iso: string | null | undefined, localDate: string, fallbackOffsetMinutes: number, timeZone?: string): boolean {
  if (!iso) return false;
  return localDateOfIso(iso, timeZone, fallbackOffsetMinutes) === localDate;
}

/** Outcome tags of the most recent event, for continuity scoring (E6). */
function outcomeDetailTagsFor(event: LifeEventRow | undefined, def: LifeActivityDefinition | undefined): string[] | null {
  if (!event) return null;
  const meta = safeMeta(event.meta_json);
  const resultType = meta.resultType as string | undefined;
  return resultType && def ? outcomeDetailTags(def, resultType) : [];
}
