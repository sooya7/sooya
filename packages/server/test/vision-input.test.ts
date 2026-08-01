import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { prepareVisionInput } from '../src/media/vision-input.js';

describe('vision input preprocessing', () => {
  it('resizes a large image into a bounded derived input without changing the source buffer', async () => {
    const source = await sharp({ create: { width: 3000, height: 1800, channels: 3, background: { r: 30, g: 80, b: 140 } } }).png().toBuffer();
    const prepared = await prepareVisionInput(source, 'image/png');
    expect(prepared).not.toBeNull();
    expect(prepared!.degraded).toBe(true);
    expect(prepared!.mime).toBe('image/jpeg');
    expect(prepared!.data.length).toBeLessThan(4 * 1024 * 1024);
    const dimensions = await sharp(prepared!.data).metadata();
    expect(Math.max(dimensions.width!, dimensions.height!)).toBeLessThanOrEqual(2048);
    expect(source.length).toBeGreaterThan(0);
  });

  it('returns null for unreadable image bytes instead of feeding arbitrary data to vision', async () => {
    expect(await prepareVisionInput(Buffer.from('not an image'), 'image/png')).toBeNull();
  });
});
