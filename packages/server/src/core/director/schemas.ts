import { z } from 'zod';

export const StickerPickSchema = z.object({
  stickerId: z.string().trim().min(1).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional()
});
export type StickerPickOutput = z.infer<typeof StickerPickSchema>;

export const VoiceDirectorSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  // Accept a finite provider value and normalize it at the Director boundary;
  // this preserves the safe 0.94–1.05 contract even when a model drifts.
  speed: z.number().finite().transform((value) => Math.min(1.05, Math.max(0.94, value))).default(1)
});
export type VoiceDirectorOutput = z.infer<typeof VoiceDirectorSchema>;

export const ImageDirectorSchema = z.object({
  prompt: z.string().trim().min(10).max(4000),
  aspectRatio: z.string().trim().max(20).optional(),
  /** Canonical complete outfit for on-camera SOOYA images; omitted for POV/scenery. */
  outfit: z.string().trim().min(4).max(500).optional()
});
export type ImageDirectorOutput = z.infer<typeof ImageDirectorSchema>;
