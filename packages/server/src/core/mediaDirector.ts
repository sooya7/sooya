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

export interface ImageDirectorIntent {
  scene: string;
  action?: string;
  mood?: string;
  intent?: string;
}

export interface ImageDirectorResult {
  prompt: string;
  aspectRatio?: string;
}

export interface VideoDirectorIntent {
  scene: string;
  intent?: string;
}

export interface VideoDirectorResult {
  prompt: string;
  aspectRatio?: string;
  durationSec?: number;
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

  image(intent: ImageDirectorIntent, opts: { sceneKey?: string | null } = {}): ImageDirectorResult {
    return { prompt: composeImagePrompt(intent, this.spec(), opts.sceneKey ?? null) };
  }

  video(intent: VideoDirectorIntent): VideoDirectorResult {
    const spec = this.spec();
    return { prompt: composeVideoPrompt(intent, spec), durationSec: spec.video.durationSec.min };
  }
}

/** Image2 prompt: her intent, then the operator's words. */
export function composeImagePrompt(
  intent: ImageDirectorIntent,
  spec: MediaPromptSpec = DEFAULT_MEDIA_PROMPT_SPEC,
  sceneKey?: string | null
): string {
  const scene = sceneKey ? spec.image.scenes[sceneKey] : undefined;
  return [
    intent.scene,
    intent.action ? `Action: ${intent.action}.` : null,
    intent.mood ? `Mood: ${intent.mood}.` : null,
    intent.intent ? `Intent: ${intent.intent}.` : null,
    scene ? [scene.suffix, scene.camera].filter(Boolean).join(', ') + '.' : null,
    spec.image.style.length ? `${spec.image.style.join(', ')}.` : null,
    spec.image.avoid.length ? `Avoid: ${spec.image.avoid.join(', ')}.` : null,
    spec.boundaries.disallowed.length ? `Never: ${spec.boundaries.disallowed.join(', ')}.` : null
  ].filter(Boolean).join(' ');
}

/** Video prompt: same contract, with the clip-length and camera vocabulary of the spec. */
export function composeVideoPrompt(
  intent: VideoDirectorIntent,
  spec: MediaPromptSpec = DEFAULT_MEDIA_PROMPT_SPEC
): string {
  return [
    intent.scene,
    intent.intent ? `Intent: ${intent.intent}.` : null,
    spec.video.style.length ? `${spec.video.style.join(', ')}.` : null,
    spec.video.camera.length ? `${spec.video.camera[0] ?? ''}, natural small movements.` : null,
    spec.video.avoid.length ? `Avoid: ${spec.video.avoid.join(', ')}.` : null,
    spec.boundaries.disallowed.length ? `Never: ${spec.boundaries.disallowed.join(', ')}.` : null
  ].filter(Boolean).join(' ');
}

export type { VoiceDeliveryPlan } from './voice/types.js';
