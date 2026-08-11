import sharp from 'sharp';
import {
  STICKER_GIF_ANALYSIS_MAX_FRAMES,
  STICKER_GIF_CONTEXT_FALLBACK_FRAMES
} from '../core/stickers/constants.js';

export interface StickerVisionFrame {
  data: Buffer;
  mime: 'image/jpeg';
  index: number;
  total: number;
}

/**
 * Convert a sticker to bounded derived JPEGs for a vision request. Animated
 * GIF/WebP files are sampled across their timeline and near-identical frames
 * are discarded; the original media bytes are never written back.
 */
export async function prepareStickerVisionFrames(
  data: Buffer,
  mime: string,
  maxFrames = STICKER_GIF_ANALYSIS_MAX_FRAMES
): Promise<StickerVisionFrame[]> {
  const normalized = mime.split(';')[0]?.toLowerCase() ?? '';
  try {
    const metadata = await sharp(data, { failOn: 'error' }).metadata();
    const pages = Math.max(1, metadata.pages ?? 1);
    const animated = pages > 1 || normalized === 'image/gif';
    const wanted = animated ? Math.min(Math.max(1, maxFrames), STICKER_GIF_ANALYSIS_MAX_FRAMES) : 1;
    const indexes = animated ? sampleFrameIndexes(pages, wanted) : [0];
    const frames: StickerVisionFrame[] = [];
    let previousSignature: Buffer | null = null;
    for (const index of indexes) {
      const source = animated ? sharp(data, { animated: true, page: index, failOn: 'error' }) : sharp(data, { failOn: 'error' });
      const normalizedFrame = await source
        .rotate()
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 78, progressive: true, mozjpeg: true })
        .toBuffer();
      const signature = await sharp(normalizedFrame)
        .resize({ width: 16, height: 16, fit: 'fill' })
        .grayscale()
        .raw()
        .toBuffer();
      if (previousSignature && pixelDistance(previousSignature, signature) < 0.035) continue;
      previousSignature = signature;
      frames.push({ data: normalizedFrame, mime: 'image/jpeg', index, total: pages });
    }
    return frames.slice(0, wanted);
  } catch {
    return [];
  }
}

/** The small context fallback intentionally sends fewer frames than analysis. */
export async function prepareStickerContextFrames(data: Buffer, mime: string): Promise<StickerVisionFrame[]> {
  return prepareStickerVisionFrames(data, mime, STICKER_GIF_CONTEXT_FALLBACK_FRAMES);
}

function sampleFrameIndexes(total: number, count: number): number[] {
  if (total <= count) return Array.from({ length: total }, (_, index) => index);
  if (count <= 1) return [0];
  const indexes = new Set<number>();
  for (let i = 0; i < count; i++) indexes.add(Math.min(total - 1, Math.round((i * (total - 1)) / (count - 1))));
  return [...indexes].sort((a, b) => a - b);
}

function pixelDistance(left: Buffer, right: Buffer): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 1;
  let total = 0;
  for (let i = 0; i < length; i++) total += Math.abs(left[i]! - right[i]!) / 255;
  return total / length;
}
