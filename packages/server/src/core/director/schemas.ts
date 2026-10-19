import { z } from 'zod';

export const StickerPickSchema = z.object({
  stickerId: z.string().trim().min(1).nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional()
});
export type StickerPickOutput = z.infer<typeof StickerPickSchema>;
