import { z } from 'zod';
import type { SettingsRepo } from '../db/repos/misc.repo.js';
import {
  resolveVisualTime,
  visualDayPeriodLighting,
  type VisualTimeContext
} from './visual-time.js';

export const DAILY_IMAGE_CONTINUITY_KEY = 'image.dailyVisualContinuity.v1';

export type OutfitMode = 'new_day' | 'locked' | 'layer_adjustment' | 'full_change';

export interface DailyImageContinuityState {
  version: 1;
  dateKey: string;
  outfit: {
    fullDescription: string;
  };
  outfitRevision: number;
  activity: string | null;
  activityKind: string | null;
  activityStartedAt: string | null;
  location: string | null;
  scene: string;
  changeReason: string | null;
  sourceMediaId: string | null;
  updatedAt: string;
}

export interface VisualLifeSnapshot {
  activity?: string | null;
  kind?: string | null;
  mood?: string | null;
  startedAt?: string | null;
}

export interface PrepareImageContinuityInput {
  scene: string;
  userText?: string | null;
  activity?: string | null;
  activityKind?: string | null;
  activityStartedAt?: string | null;
  location?: string | null;
  now?: string | Date;
  localDate?: string | null;
  timeZone?: string | null;
  visualTime?: VisualTimeContext;
}

export interface PreparedImageContinuity {
  dateKey: string;
  visualTime: VisualTimeContext;
  currentActivity: string | null;
  currentActivityKind: string | null;
  currentActivityStartedAt: string | null;
  currentLocation: string | null;
  currentScene: string;
  previousOutfit: string | null;
  previousOutfitRevision: number;
  previousActivity: string | null;
  previousScene: string | null;
  outfitMode: OutfitMode;
  outfitRevision: number;
  changeReason: string | null;
  explicitOutfitRequest: string | null;
}

export interface CommitImageContinuityInput {
  outfit: string;
  scene: string;
  mediaId: string;
}

const DailyImageContinuityStateSchema = z.object({
  version: z.literal(1),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  outfit: z.object({
    fullDescription: z.string().trim().min(4).max(500)
  }),
  outfitRevision: z.number().int().min(1),
  activity: z.string().trim().max(300).nullable(),
  activityKind: z.string().trim().max(100).nullable(),
  activityStartedAt: z.string().trim().max(80).nullable(),
  location: z.string().trim().max(300).nullable(),
  scene: z.string().trim().min(1).max(1000),
  changeReason: z.string().trim().max(100).nullable(),
  sourceMediaId: z.string().trim().max(160).nullable(),
  updatedAt: z.string().trim().min(1).max(80)
});

const KEEP_OUTFIT_RE = /(?:不要|别|不许|不用).{0,8}(?:换|改).{0,8}(?:衣|穿搭|造型)|(?:还是|继续|保持|沿用|同一|一样).{0,10}(?:这套|衣服|穿搭|造型)|衣服.{0,8}(?:别变|不变|一样)|(?:keep|same).{0,16}outfit/iu;
const LAYER_ADJUST_RE = /(?:脱(?:掉|下)?|穿(?:上|件|一件)?|套上|加上|披上|拿掉|去掉|解开).{0,8}(?:外套|大衣|夹克|开衫|围巾)|(?:外套|大衣|夹克|开衫|围巾).{0,8}(?:脱|穿|套|加|披|拿掉|去掉)|(?:take off|put on|add|remove).{0,16}(?:coat|jacket|cardigan|scarf)/iu;
const EXPLICIT_CHANGE_RE = /(?:换(?:一|另|第[二2])?(?:件|套|身)?.{0,16}(?:衣服|衣裳|穿搭|造型|衣装|外套|连衣裙|裙子|裤子|鞋|睡衣|运动服|泳衣|礼服|西装)|换(?:一|另|第[二2])?(?:套|身)(?:吧|穿搭|造型)?|换装|(?:换成|改穿|穿成).{0,16}(?:衣|裙|裤|鞋|外套|睡衣|运动服|泳衣|礼服|西装)|穿上.{0,10}(?:睡衣|运动服|泳衣|礼服|西装|裙子)|(?:change|switch to|wear another).{0,16}outfit)/iu;
const CHANGE_OBSERVATION_RE = /(?:怎么|为什么|为何|是不是|是否|有没有).{0,18}(?:衣服|穿搭|造型|外套).{0,8}(?:换|变|不一样|穿上|脱)|(?:怎么|为什么|为何|是不是|是否|有没有).{0,18}(?:换|变|不一样|穿上|脱).{0,8}(?:衣服|穿搭|造型|外套)|(?:换|变|穿上|脱).{0,8}(?:衣服|穿搭|造型|外套).{0,4}(?:了)?(?:吗|呢|？|\?)|(?:衣服|穿搭|造型|外套).{0,8}(?:换|变|穿上|脱).{0,6}(?:了)?(?:吗|呢|？|\?)/iu;

type SpecialActivity = 'shower' | 'sleep' | 'exercise' | 'swimming' | 'formal';

function specialActivityOf(value: string): SpecialActivity | null {
  if (/游泳|泳池|下水|温泉|泡温泉|swim|pool|hot spring/iu.test(value)) return 'swimming';
  if (/洗澡|淋浴|沐浴|泡澡|浴室|shower|bath/iu.test(value)) return 'shower';
  if (/睡觉|睡前|准备睡|上床|起床|刚醒|睡醒|卧床|sleep|bedtime|waking/iu.test(value)) return 'sleep';
  if (/健身|跑步|运动|瑜伽|普拉提|锻炼|球馆|workout|gym|running|yoga|exercise/iu.test(value)) return 'exercise';
  if (/婚礼|宴会|晚宴|颁奖|正式聚会|面试|商务会议|典礼|礼服|formal|wedding|banquet|interview/iu.test(value)) return 'formal';
  return null;
}

function cleanOptional(value: string | null | undefined, max: number): string | null {
  const cleaned = value?.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function normalizeForRules(...values: Array<string | null | undefined>): string {
  return values.filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase();
}

function cleanOutfit(value: string | null | undefined): string | null {
  const cleaned = value
    ?.replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned || cleaned.length < 4) return null;
  return cleaned.slice(0, 500);
}

function defaultOutfit(decision: PreparedImageContinuity): string {
  const authoritativeContext = decision.visualTime.mode === 'retrospective'
    ? normalizeForRules(decision.currentScene, decision.explicitOutfitRequest)
    : decision.currentActivity || decision.currentActivityKind
      ? normalizeForRules(decision.currentActivity, decision.currentActivityKind)
      : normalizeForRules(decision.currentScene);
  const context = normalizeForRules(
    authoritativeContext,
    decision.changeReason,
    decision.explicitOutfitRequest
  );
  const special = specialActivityOf(context);
  if (special === 'shower') return '浅色柔软浴袍和简洁防滑室内拖鞋';
  if (special === 'sleep') return '宽松浅色家居上衣、深色柔软家居长裤和简洁室内拖鞋';
  if (special === 'exercise') return '深色轻便运动外套、透气运动上衣、黑色运动长裤和白色运动鞋';
  if (special === 'swimming') return '黑色简洁连体泳衣、白色轻薄罩衫和防滑凉拖';
  if (special === 'formal') return '剪裁简洁的深色连衣裙、低调耳饰和黑色低跟鞋';

  const request = decision.explicitOutfitRequest ?? '';
  const color = request.match(/黑色|白色|灰色|米色|浅色|深色|红色|蓝色|绿色|粉色|紫色|黄色|棕色/gu)?.[0] ?? '简洁';
  if (/连衣裙/u.test(request)) return `${color}连衣裙、低调配饰和协调色低跟鞋`;
  if (/半身裙|裙子/u.test(request)) return `${color}简洁上衣、协调色半身裙和白色休闲鞋`;
  if (/牛仔裤/u.test(request)) return `${color}简洁上衣、蓝色直筒牛仔裤和白色休闲鞋`;
  return '黑色轻便休闲外套、浅色简洁内搭、深色直筒长裤和白色休闲鞋';
}

/**
 * Owns the one persisted same-day outfit and serializes all SOOYA selfie
 * generations. prepare() is read-only; commit() is called only after the media
 * file has been generated and saved successfully.
 */
export class ImageContinuityService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: SettingsRepo,
    private readonly options: {
      clock?: () => Date;
      timeZone?: string;
      onEvent?: (event: string, data: Record<string, unknown>) => void;
    } = {}
  ) {}

  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  current(): DailyImageContinuityState | null {
    const parsed = DailyImageContinuityStateSchema.safeParse(
      this.settings.get<unknown>(DAILY_IMAGE_CONTINUITY_KEY, null)
    );
    return parsed.success ? parsed.data : null;
  }

  prepare(input: PrepareImageContinuityInput): PreparedImageContinuity {
    const now = input.now instanceof Date
      ? input.now
      : input.now
        ? new Date(input.now)
        : (this.options.clock?.() ?? new Date());
    const resolvedNow = Number.isFinite(now.getTime()) ? now : (this.options.clock?.() ?? new Date());
    const visualTime = input.visualTime ?? resolveVisualTime({
      now: resolvedNow,
      timeZone: input.timeZone ?? this.options.timeZone,
      latestUserText: input.userText
    });
    const dateKey = visualTime.currentLocalDate;
    const stored = this.current();
    const state = visualTime.mode === 'current' && stored?.dateKey === dateKey ? stored : null;
    // A temporarily incomplete snapshot must not erase known same-day
    // reality. Keep the last committed activity/location until Life or World
    // supplies a newer authoritative value.
    const currentActivity = cleanOptional(input.activity, 300) ?? state?.activity ?? null;
    const currentActivityKind = cleanOptional(input.activityKind, 100) ?? state?.activityKind ?? null;
    const currentActivityStartedAt = cleanOptional(input.activityStartedAt, 80) ?? state?.activityStartedAt ?? null;
    const currentLocation = cleanOptional(input.location, 300) ?? state?.location ?? null;
    const scene = cleanOptional(input.scene, 1000) ?? 'ordinary daily-life selfie';
    const userText = cleanOptional(input.userText, 1000);
    // Life/event activity is authoritative when present. A creative scene
    // proposed by the main model cannot by itself manufacture an activity
    // transition (and thereby unlock a wardrobe change).
    const currentRules = currentActivity || currentActivityKind
      ? normalizeForRules(currentActivity, currentActivityKind)
      : normalizeForRules(scene);
    const previousRules = state?.activity || state?.activityKind
      ? normalizeForRules(state.activity, state.activityKind)
      : normalizeForRules(state?.scene);
    const layerRules = normalizeForRules(currentActivity, currentActivityKind, scene);

    let outfitMode: OutfitMode = 'new_day';
    let changeReason: string | null = state ? null : (stored ? 'new_calendar_day' : 'first_selfie_of_day');
    let explicitOutfitRequest: string | null = null;

    if (visualTime.mode === 'retrospective') {
      outfitMode = 'full_change';
      changeReason = 'retrospective_scene';
      if (userText && (EXPLICIT_CHANGE_RE.test(userText) || LAYER_ADJUST_RE.test(userText))) {
        explicitOutfitRequest = userText;
      }
    } else if (state) {
      outfitMode = 'locked';
      if (userText && KEEP_OUTFIT_RE.test(userText)) {
        changeReason = 'user_keep_request';
      } else if (userText && CHANGE_OBSERVATION_RE.test(userText)) {
        changeReason = 'user_continuity_correction';
      } else if (userText && LAYER_ADJUST_RE.test(userText)) {
        outfitMode = 'layer_adjustment';
        changeReason = 'user_layer_request';
        explicitOutfitRequest = userText;
      } else if (userText && EXPLICIT_CHANGE_RE.test(userText)) {
        outfitMode = 'full_change';
        changeReason = 'user_request';
        explicitOutfitRequest = userText;
      } else if (LAYER_ADJUST_RE.test(layerRules)) {
        outfitMode = 'layer_adjustment';
        changeReason = 'environment_layer_adjustment';
      } else {
        const currentSpecial = specialActivityOf(currentRules);
        const previousSpecial = specialActivityOf(previousRules);
        if (currentSpecial && currentSpecial !== previousSpecial) {
          outfitMode = 'full_change';
          changeReason = currentSpecial;
        } else if (!currentSpecial && previousSpecial) {
          outfitMode = 'full_change';
          changeReason = `${previousSpecial}_ended`;
        }
      }
    } else if (userText && (EXPLICIT_CHANGE_RE.test(userText) || LAYER_ADJUST_RE.test(userText))) {
      explicitOutfitRequest = userText;
    }

    const previousOutfitRevision = state?.outfitRevision ?? 0;
    const outfitRevision = outfitMode === 'new_day'
      ? 1
      : outfitMode === 'locked'
        ? Math.max(1, previousOutfitRevision)
        : Math.max(1, previousOutfitRevision + 1);
    const decision: PreparedImageContinuity = {
      dateKey,
      visualTime,
      currentActivity,
      currentActivityKind,
      currentActivityStartedAt,
      currentLocation,
      currentScene: scene,
      previousOutfit: state?.outfit.fullDescription ?? null,
      previousOutfitRevision,
      previousActivity: state?.activity ?? null,
      previousScene: state?.scene ?? null,
      outfitMode,
      outfitRevision,
      changeReason,
      explicitOutfitRequest
    };
    this.options.onEvent?.('prepared', {
      dateKey,
      outfitMode,
      outfitRevision,
      changeReason,
      activity: currentActivity,
      location: currentLocation,
      timeMode: visualTime.mode
    });
    return decision;
  }

  resolveOutfit(directorOutfit: string | null | undefined, decision: PreparedImageContinuity): string {
    if (decision.outfitMode === 'locked' && decision.previousOutfit) return decision.previousOutfit;
    const directed = cleanOutfit(directorOutfit);
    if (directed) return directed;
    if (decision.outfitMode === 'layer_adjustment' && decision.previousOutfit) return decision.previousOutfit;
    return defaultOutfit(decision);
  }

  applyToPrompt(prompt: string, decision: PreparedImageContinuity, outfit: string): string {
    const resolvedOutfit = cleanOutfit(outfit) ?? this.resolveOutfit(null, decision);
    const activity = decision.currentActivity ?? 'unknown ordinary daily activity; do not invent a conflicting activity';
    const location = decision.currentLocation ?? 'the real current location implied by the activity; do not invent a conflicting place';
    const outfitRule = decision.outfitMode === 'locked'
      ? 'This is the exact same-day outfit. Keep every garment type, color, material, and layer unchanged.'
      : decision.outfitMode === 'layer_adjustment'
        ? 'Only an outer layer may be added or removed. Keep the inner top, bottom, shoes, colors, and materials consistent with the prior outfit.'
        : decision.outfitMode === 'full_change'
          ? `A full outfit change is allowed only for this reason: ${decision.changeReason ?? 'explicitly approved transition'}.`
          : 'This is the first on-camera outfit for this local calendar day and becomes the same-day baseline.';
    const explicitRule = decision.explicitOutfitRequest
      ? `User's explicit outfit request (authoritative): ${decision.explicitOutfitRequest}`
      : null;
    const sceneRules = decision.visualTime.mode === 'current'
      ? [
          `Real current activity: ${activity}.`,
          `Real current location: ${location}.`,
          'Use the current activity and location above as authoritative. A new angle, composition, or ordinary location change must not create a different activity or outfit.'
        ]
      : [
          'This is a newly generated retrospective depiction, not current reality and not proof of a stored historical photo.',
          'Follow the latest explicit past-scene request and intended scene. Do not reuse current Life activity or location as historical facts.'
        ];
    const time = decision.visualTime;
    return [
      prompt.trim(),
      '',
      'DAILY VISUAL CONTINUITY — HARD CONSTRAINTS:',
      `Local calendar date: ${decision.dateKey}.`,
      ...sceneRules,
      `SOOYA's complete outfit: ${resolvedOutfit}.`,
      outfitRule,
      explicitRule,
      'Ignore and override any earlier clothing description that conflicts with the complete outfit above.',
      '',
      'VISUAL TIME CONTINUITY — FINAL HARD CONSTRAINTS:',
      `Real current local time: ${time.currentLocalDate} ${time.currentLocalTime} (${time.currentDayPeriod}, ${time.timeZone}).`,
      `Time mode: ${time.mode}.`,
      `Depicted local date: ${time.depictedLocalDate}.`,
      `Depicted day period: ${time.depictedDayPeriod}.`,
      `Required scene lighting: ${visualDayPeriodLighting(time.depictedDayPeriod)}.`,
      'Ignore and override any earlier time-of-day or lighting description that conflicts with this final block.'
    ].filter((line): line is string => Boolean(line)).join('\n');
  }

  commit(decision: PreparedImageContinuity, input: CommitImageContinuityInput): DailyImageContinuityState | null {
    if (decision.visualTime.mode === 'retrospective') {
      this.options.onEvent?.('commit_skipped', {
        reason: 'retrospective_scene',
        sourceMediaId: cleanOptional(input.mediaId, 160),
        depictedLocalDate: decision.visualTime.depictedLocalDate,
        depictedDayPeriod: decision.visualTime.depictedDayPeriod
      });
      return null;
    }
    const outfit = cleanOutfit(input.outfit);
    const scene = cleanOptional(input.scene, 1000);
    const mediaId = cleanOptional(input.mediaId, 160);
    if (!outfit || !scene || !mediaId) throw new Error('invalid image continuity commit');
    const current = this.current();
    const sameDayCurrent = current?.dateKey === decision.dateKey ? current : null;
    const outfitRevision = decision.outfitMode === 'locked' && sameDayCurrent
      ? sameDayCurrent.outfitRevision
      : decision.outfitMode === 'new_day' || !sameDayCurrent
        ? 1
        : sameDayCurrent.outfitRevision + 1;
    const state: DailyImageContinuityState = {
      version: 1,
      dateKey: decision.dateKey,
      outfit: { fullDescription: decision.outfitMode === 'locked' && sameDayCurrent ? sameDayCurrent.outfit.fullDescription : outfit },
      outfitRevision,
      activity: decision.currentActivity,
      activityKind: decision.currentActivityKind,
      activityStartedAt: decision.currentActivityStartedAt,
      location: decision.currentLocation,
      scene,
      changeReason: decision.changeReason,
      sourceMediaId: mediaId,
      updatedAt: (this.options.clock?.() ?? new Date()).toISOString()
    };
    this.settings.set(DAILY_IMAGE_CONTINUITY_KEY, state);
    this.options.onEvent?.('committed', {
      dateKey: state.dateKey,
      outfitMode: decision.outfitMode,
      outfitRevision: state.outfitRevision,
      changeReason: state.changeReason,
      sourceMediaId: mediaId
    });
    return state;
  }
}
