import type { VoiceDeliveryPlan } from './types.js';

/**
 * FishCueRenderer — deterministic VoiceDirector for Fish Audio S2.x.
 *
 * Maps the provider-agnostic VoiceDeliveryPlan onto the Fish S2 natural-
 * language cue whitelist (implementation doc §5, §7, §16):
 *
 * - LLM output never reaches Fish raw: every cue comes from this table.
 * - Whitelist only, from the doc's published table. Moods without a doc cue
 *   (sad, angry, sleepy) map to NO cue rather than an invented one.
 * - Restraint first: "no cue > wrong cue > over-acted". Intensity 0 or a plain
 *   statement yields no cue; happy maps to the doc's [excited] entry, which is
 *   its intended default at intensity 1.
 * - The transcript is never touched: cues are prepended to the synthesis text
 *   only, and the visible transcript stays clean.
 * - One cue at most. Banned over-the-top tags are stripped even from the table.
 */

export interface FishCueSpec {
  /** Fish S2 bracket cue, or null for no cue. */
  cue: string | null;
  /** Default prosody.speed for this mood (clamped to 0.94–1.05 per the quality spec §5). */
  speed: number;
}

/**
 * Domain `primaryEmotion` → Fish cue, sourced from the media quality spec's
 * whitelist (§3): default no cue, at most one main cue per short utterance,
 * restrained over drama. Emotions the spec does not name (sad, angry) get
 * `cue: null` — silence beats a guess.
 */
export const FISH_MOOD_TABLE: Record<VoiceDeliveryPlan['primaryEmotion'], FishCueSpec> = {
  neutral: { cue: null, speed: 1.0 },
  // 开心 1.00–1.05.
  happy: { cue: '[warm and relaxed]', speed: 1.02 },
  // 温柔 0.96–0.99.
  gentle: { cue: '[speaking softly]', speed: 0.97 },
  sad: { cue: null, speed: 0.97 },
  angry: { cue: null, speed: 1.0 },
  // 困倦 0.94–0.98.
  sleepy: { cue: '[slightly sleepy]', speed: 0.96 },
  playful: { cue: '[small chuckle]', speed: 1.02 },
  serious: { cue: null, speed: 0.99 }
};

/**
 * Moods the domain enum does not carry yet. These are only reachable
 * when a caller explicitly passes a `moodAlias`; kept available so a future
 * mood extension needs no table change.
 */
export const FISH_ALIAS_CUE: Record<string, FishCueSpec> = {
  warm: { cue: '[warm and relaxed]', speed: 0.98 },
  tender: { cue: '[speaking softly]', speed: 0.97 },
  curious: { cue: null, speed: 1.0 },
  concerned: { cue: null, speed: 0.97 },
  reassuring: { cue: '[gently reassuring]', speed: 0.97 },
  shy: { cue: '[slightly shy]', speed: 0.98 },
  excited: { cue: '[warm and relaxed]', speed: 1.03 }
};

/** Over-the-top tags banned in Phase 1 (doc §5.1). */
const BANNED_CUE_FRAGMENTS = ['[laughing]', '[sobbing]', '[shouting]', '[screaming]', '[panting]'];

/**
 * Resolve the Fish cue spec for a delivery plan.
 *
 * `intensity` (0/1/2) is derived from the plan's energy profile when not
 * supplied: energy >= 0.65 reads as 1, otherwise 0. Intensity 0 suppresses the
 * cue entirely — short and plain statements stay cue-free.
 */
export function fishCueFor(plan: VoiceDeliveryPlan, opts: { intensity?: 0 | 1 | 2; moodAlias?: string } = {}): FishCueSpec {
  const intensity = opts.intensity ?? (plan.energy >= 0.65 ? 1 : 0);
  return fishCueForMood(plan.primaryEmotion, { intensity, moodAlias: opts.moodAlias, pace: plan.pace });
}

/**
 * Mood-string variant for thin transports (providers) that only carry
 * `opts.emotion` + `opts.speed` and never see a full delivery plan.
 */
export function fishCueForMood(
  mood: string,
  opts: { intensity?: 0 | 1 | 2; moodAlias?: string; pace?: number } = {}
): FishCueSpec {
  const intensity = opts.intensity ?? 1;
  if (intensity === 0) return { cue: null, speed: clampSpeed(opts.pace ?? 1) };

  const alias = opts.moodAlias ? FISH_ALIAS_CUE[opts.moodAlias] : undefined;
  const spec = FISH_MOOD_TABLE[mood as VoiceDeliveryPlan['primaryEmotion']] ?? { cue: null, speed: 1.0 };
  // An explicit alias wins even when it maps to no cue: "no cue > wrong cue".
  const cue = alias ? alias.cue : spec.cue;
  const speed = alias?.speed ?? spec.speed;
  if (!cue || BANNED_CUE_FRAGMENTS.some((banned) => cue.includes(banned))) {
    return { cue: null, speed: clampSpeed(speed) };
  }
  return { cue, speed: clampSpeed(speed) };
}

/**
 * Render the final Fish synthesis text: an optional cue prefix followed by the
 * clean spoken transcript. The transcript is the caller's already-normalized
 * synthesis text — this function only prefixes, never rewrites.
 */
export function renderFishSynthesisText(
  synthesisText: string,
  plan: VoiceDeliveryPlan,
  opts: { intensity?: 0 | 1 | 2; moodAlias?: string } = {}
): string {
  const { cue } = fishCueFor(plan, opts);
  return prefixCue(synthesisText, cue);
}

/** Mood-string variant for providers that only carry `opts.emotion`. */
export function renderFishSynthesisTextForMood(
  synthesisText: string,
  mood: string,
  opts: { intensity?: 0 | 1 | 2; moodAlias?: string } = {}
): string {
  const { cue } = fishCueForMood(mood, opts);
  return prefixCue(synthesisText, cue);
}

/** Resolved speed for the Fish request, clamped to the quality spec's 0.94–1.05 range. */
export function fishSpeedFor(plan: VoiceDeliveryPlan, opts: { intensity?: 0 | 1 | 2; moodAlias?: string } = {}): number {
  return fishCueFor(plan, opts).speed;
}

/** Mood-string variant of `fishSpeedFor` for thin transports. */
export function fishSpeedForMood(mood: string, opts: { intensity?: 0 | 1 | 2; moodAlias?: string } = {}): number {
  return fishCueForMood(mood, opts).speed;
}

function prefixCue(text: string, cue: string | null): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return cue ? `${cue} ${trimmed}` : trimmed;
}

function clampSpeed(speed: number): number {
  return Math.min(1.05, Math.max(0.94, Math.round(speed * 100) / 100));
}
