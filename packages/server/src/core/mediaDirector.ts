/**
 * Media prompt composition: what she asked for is the picture.
 *
 * These used to be model calls - a small "media director" model rewrote every
 * intent into an Image2 / video prompt. It rewrote her words, cost one request
 * per picture, and its failure path produced a third, different prompt. Now the
 * intent goes in as written and the operator-editable spec
 * (`media-prompt-spec.json`) supplies the style vocabulary, so what she
 * described is what gets generated.
 */
import {
  DEFAULT_MEDIA_PROMPT_SPEC,
  type MediaPromptSpec
} from '../config/media-spec.js';
import {
  visualDayPeriodLighting,
  type VisualTimeContext
} from './visual-time.js';

export interface ImageDirectorIntent {
  scene: string;
  action?: string;
  mood?: string;
  intent?: string;
  /** The picture is of her, so the pipeline attaches her reference image. */
  self?: boolean;
}

export interface ImageDirectorResult {
  prompt: string;
  aspectRatio?: string;
  /** Same-day outfit kept for on-camera pictures, so the next one agrees with it. */
  outfit?: string;
}

export interface VideoDirectorIntent {
  scene: string;
  /** SOOYA herself is on camera; the first frame will be one of her reference images. */
  self?: boolean;
  intent?: string;
}

export interface VideoDirectorResult {
  prompt: string;
  aspectRatio?: string;
  durationSec?: number;
}

/** Same-day reality a clip has to agree with; see core/video/continuity.ts. */
export interface VideoDirectorContinuity {
  dateKey: string;
  outfit?: string | null;
  activity?: string | null;
  location?: string | null;
  lighting: string;
  depictedDayPeriod: string;
  timeMode: string;
}

export interface ImageDirectorContinuity {
  dateKey?: string;
  currentActivity?: string | null;
  currentLocation?: string | null;
  previousOutfit?: string | null;
  outfitMode: 'new_day' | 'locked' | 'layer_adjustment' | 'full_change';
  changeReason?: string | null;
  explicitOutfitRequest?: string | null;
  visualTime: VisualTimeContext;
}

/**
 * Strips any leading `[bracket cue]` from a script. FishCueRenderer is the only
 * cue producer, so a cue here is always wrong.
 */
export function sanitizeFishText(text: string): string {
  const cueMatch = /^(\[[^\]]+\])\s*(.+)$/s.exec(text.trim());
  if (!cueMatch) return text.trim();
  return cueMatch[2]!.trim();
}

export class MediaDirector {
  constructor(
    /** Operator-editable style/negative/scene vocabulary; defaults when absent. */
    private readonly spec: () => MediaPromptSpec = () => DEFAULT_MEDIA_PROMPT_SPEC
  ) {}

  image(
    intent: ImageDirectorIntent,
    opts: { signal?: AbortSignal; continuity?: ImageDirectorContinuity; sceneKey?: string | null } = {}
  ): ImageDirectorResult {
    const continuity = opts.continuity;
    const keptOutfit = continuity?.previousOutfit
      && (continuity.outfitMode === 'locked' || continuity.outfitMode === 'layer_adjustment')
      ? continuity.previousOutfit
      : undefined;
    return {
      prompt: composeImagePrompt(intent, this.spec(), continuity, opts.sceneKey ?? null),
      ...(intent.self && keptOutfit ? { outfit: keptOutfit } : {})
    };
  }

  video(
    intent: VideoDirectorIntent,
    opts: { signal?: AbortSignal; continuity?: VideoDirectorContinuity } = {}
  ): VideoDirectorResult {
    const spec = this.spec();
    return { prompt: composeVideoPrompt(intent, spec, opts.continuity), durationSec: spec.video.durationSec.min };
  }
}

/** Image2 prompt: her intent, then the operator's words, then the reality constraints. */
export function composeImagePrompt(
  intent: ImageDirectorIntent,
  spec: MediaPromptSpec = DEFAULT_MEDIA_PROMPT_SPEC,
  continuity?: ImageDirectorContinuity,
  sceneKey?: string | null
): string {
  const scene = sceneKey ? spec.image.scenes[sceneKey] : undefined;
  const outfitConstraint = continuity?.previousOutfit
    && (continuity.outfitMode === 'locked' || continuity.outfitMode === 'layer_adjustment')
    ? `Same-day outfit: ${continuity.previousOutfit}. ${continuity.outfitMode === 'locked'
      ? 'Keep every garment, color, material, and layer exactly unchanged.'
      : 'Only the outermost layer may change; keep every other garment unchanged.'}`
    : null;
  return [
    intent.self ? 'Use the provided reference image as the identity reference for Sooya.' : null,
    intent.self ? 'Preserve the same person and facial identity without redesigning her appearance.' : null,
    intent.scene,
    intent.action ? `Action: ${intent.action}.` : null,
    intent.mood ? `Mood: ${intent.mood}.` : null,
    intent.intent ? `Intent: ${intent.intent}.` : null,
    scene ? [scene.suffix, scene.camera].filter(Boolean).join(', ') + '.' : null,
    continuity?.currentActivity ? `Real current activity: ${continuity.currentActivity}.` : null,
    continuity?.currentLocation ? `Real current location: ${continuity.currentLocation}.` : null,
    intent.self ? outfitConstraint : null,
    intent.self && continuity?.explicitOutfitRequest ? `Explicit outfit request: ${continuity.explicitOutfitRequest}.` : null,
    continuity?.visualTime
      ? `Real current local time: ${continuity.visualTime.currentLocalDate} ${continuity.visualTime.currentLocalTime} (${continuity.visualTime.currentDayPeriod}, ${continuity.visualTime.timeZone}).`
      : null,
    continuity?.visualTime
      ? `Depicted scene: ${continuity.visualTime.mode}, ${continuity.visualTime.depictedLocalDate} ${continuity.visualTime.depictedDayPeriod}. Required lighting: ${visualDayPeriodLighting(continuity.visualTime.depictedDayPeriod)}.`
      : null,
    spec.image.style.length ? `${spec.image.style.join(', ')}.` : null,
    spec.image.avoid.length ? `Avoid: ${spec.image.avoid.join(', ')}.` : null,
    spec.boundaries.disallowed.length ? `Never: ${spec.boundaries.disallowed.join(', ')}.` : null
  ].filter(Boolean).join(' ');
}

/** Video prompt: same contract, with the clip-length and camera vocabulary of the spec. */
export function composeVideoPrompt(
  intent: VideoDirectorIntent,
  spec: MediaPromptSpec = DEFAULT_MEDIA_PROMPT_SPEC,
  continuity?: VideoDirectorContinuity
): string {
  return [
    intent.self ? 'Use the provided first frame as the identity reference for Sooya; keep the same person, face and outfit.' : null,
    intent.scene,
    intent.intent ? `Intent: ${intent.intent}.` : null,
    continuity?.activity ? `Real current activity: ${continuity.activity}.` : null,
    continuity?.location ? `Real current location: ${continuity.location}.` : null,
    continuity?.outfit ? `Same-day outfit: ${continuity.outfit}.` : null,
    continuity?.lighting ? `Required lighting: ${continuity.lighting}.` : null,
    spec.video.style.length ? `${spec.video.style.join(', ')}.` : null,
    spec.video.camera.length ? `${spec.video.camera[0] ?? ''}, natural small movements.` : null,
    spec.video.avoid.length ? `Avoid: ${spec.video.avoid.join(', ')}.` : null,
    spec.boundaries.disallowed.length ? `Never: ${spec.boundaries.disallowed.join(', ')}.` : null
  ].filter(Boolean).join(' ');
}

export type { VoiceDeliveryPlan } from './voice/types.js';
