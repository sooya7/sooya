import type { ImageContinuityService, PrepareImageContinuityInput } from '../image-continuity.js';
import { applyVisualTimeToPrompt, visualDayPeriodLighting, type VisualTimeContext } from '../visual-time.js';

/**
 * What a clip of SOOYA must stay consistent with. Read out of the same
 * same-day state the selfie pipeline owns, so a video taken minutes after a
 * photo shows the same outfit in the same place at the right time of day.
 */
export interface VideoContinuity {
  dateKey: string;
  /** The locked same-day outfit, or null when today has no authoritative one yet. */
  outfit: string | null;
  activity: string | null;
  location: string | null;
  visualTime: VisualTimeContext;
}

/**
 * Reads continuity for a clip. Deliberately read-only: `commit()` is never
 * called from the video path.
 *
 * A clip finishes minutes after the reply that promised it, usually after
 * other images have already been generated, so letting it write the day's
 * outfit baseline would let a late arrival overwrite what the user actually
 * saw first. The clip therefore follows the day's outfit and never defines it.
 */
export function prepareVideoContinuity(
  service: ImageContinuityService,
  input: PrepareImageContinuityInput
): VideoContinuity {
  const decision = service.prepare(input);
  // `locked` / `layer_adjustment` mean today's outfit is authoritative. Any
  // other mode means the wardrobe is legitimately in flux (new day, explicit
  // change, shower, workout), and pinning the clip to a stale outfit would be
  // worse than letting the director dress the scene.
  const outfit = decision.outfitMode === 'locked' || decision.outfitMode === 'layer_adjustment'
    ? decision.previousOutfit
    : null;
  return {
    dateKey: decision.dateKey,
    outfit,
    activity: decision.visualTime.mode === 'current' ? decision.currentActivity : null,
    location: decision.visualTime.mode === 'current' ? decision.currentLocation : null,
    visualTime: decision.visualTime
  };
}

/**
 * Appends the continuity constraints to an expanded clip prompt. Outfit lines
 * are only meaningful when she is on camera, so the caller passes `onCamera`.
 */
export function applyVideoContinuity(prompt: string, continuity: VideoContinuity, onCamera: boolean): string {
  const lines: string[] = [];
  if (onCamera && continuity.outfit) {
    lines.push(
      `SOOYA's complete outfit: ${continuity.outfit}.`,
      'This is the exact same-day outfit already shown to the user. Keep every garment type, color, material and layer unchanged, and override any earlier clothing wording that conflicts with it.'
    );
  }
  if (continuity.visualTime.mode === 'current') {
    if (continuity.activity) lines.push(`Real current activity: ${continuity.activity}. Do not depict a conflicting activity.`);
    if (continuity.location) lines.push(`Real current location: ${continuity.location}. Do not relocate the scene.`);
  }
  lines.push(`Required lighting: ${visualDayPeriodLighting(continuity.visualTime.depictedDayPeriod)}.`);
  const withContinuity = [prompt.trim(), '', 'CLIP CONTINUITY — HARD CONSTRAINTS:', `Local calendar date: ${continuity.dateKey}.`, ...lines].join('\n');
  return applyVisualTimeToPrompt(withContinuity, continuity.visualTime);
}

/** Compact metadata for the task row and the message, so a wrong clip is explainable. */
export function videoContinuityMetadata(continuity: VideoContinuity, onCamera: boolean) {
  return {
    dateKey: continuity.dateKey,
    ...(onCamera && continuity.outfit ? { outfit: continuity.outfit } : {}),
    ...(continuity.activity ? { activity: continuity.activity } : {}),
    ...(continuity.location ? { location: continuity.location } : {}),
    timeMode: continuity.visualTime.mode,
    depictedDayPeriod: continuity.visualTime.depictedDayPeriod
  };
}
