import sharp from 'sharp';

const MAX_EDGE = 2048;
const MAX_BYTES = 4 * 1024 * 1024;

export interface VisionInput {
  data: Buffer;
  mime: 'image/jpeg';
  degraded: boolean;
  reason?: string;
}

/** Create a bounded derived image for multimodal providers; the original is never overwritten. */
export async function prepareVisionInput(data: Buffer, mime: string): Promise<VisionInput | null> {
  if (!mime.startsWith('image/')) return null;
  try {
    const source = sharp(data, { failOn: 'error' });
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) return null;
    const needsResize = Math.max(metadata.width, metadata.height) > MAX_EDGE;
    const qualities = [82, 72, 60, 48];
    for (const quality of qualities) {
      const output = await sharp(data)
        .rotate()
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, progressive: true, mozjpeg: true })
        .toBuffer();
      if (output.length <= MAX_BYTES) return { data: output, mime: 'image/jpeg', degraded: needsResize || mime !== 'image/jpeg', reason: needsResize ? 'resized_and_normalized' : 'normalized' };
    }
    return null;
  } catch {
    return null;
  }
}
