import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { prepareStickerVisionFrames } from '../src/media/sticker-vision.js';
import { resolveVisualTime } from '../src/core/visual-time.js';

let h: Harness | null = null;

afterEach(async () => {
  await h?.cleanup();
  h = null;
});

describe('Sticker V2 audit guards', () => {
  it('samples distinct GIF frames without mutating the original bytes', async () => {
    const path = fileURLToPath(new URL('./fixtures/stickers/animated.gif', import.meta.url));
    const original = fs.readFileSync(path);
    const frames = await prepareStickerVisionFrames(original, 'image/gif', 3);

    expect(frames.length).toBeGreaterThan(1);
    expect(new Set(frames.map((frame) => frame.index)).size).toBe(frames.length);
    expect(Buffer.compare(original, fs.readFileSync(path))).toBe(0);
    expect(Buffer.compare(frames[0]!.data, frames[1]!.data)).not.toBe(0);
  });

  it('caps sticker vision images across the whole request, not once per message', async () => {
    h = await createHarness();
    const stickers = h.app.services.stickerLibrary.available().slice(0, 3);
    const messages = stickers.map((sticker, index) => h!.app.repos.messages.create({
      role: 'user',
      status: 'sent',
      parts: [{ type: 'sticker', mediaId: sticker.mediaId, status: 'sent', meta: { stickerId: sticker.id } }],
      meta: { clientMsgId: `vision-budget-${index}` }
    }).message);

    const built = await h.app.services.context.build(h.app.config.getPersona(), '这些表情是什么意思？', {
      recentMessages: 20,
      memoryLimit: 0,
      allowVision: true,
      batchMessageIds: messages.map((message) => message.id),
      voiceMoods: '',
      capabilityNotes: [],
      contextWindow: 8192,
      maxOutputTokens: 1000,
      visualTime: resolveVisualTime({ now: '2026-08-26T05:17:23.000Z' })
    });
    const imageCount = built.turns.flatMap((turn) => turn.content).filter((part) => part.type === 'image').length;
    expect(imageCount).toBe(2);
  });

  it('advances the cursor over missing files instead of repeating visible stickers', async () => {
    h = await createHarness();
    const first = h.app.services.stickerLibrary.available()[0]!;
    const media = h.app.repos.media.get(first.mediaId)!;
    await fs.promises.rm(h.app.services.mediaStore.absolutePath(media), { force: true });
    h.app.services.stickerLibrary.invalidate();

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const url = cursor ? `/api/stickers?limit=2&cursor=${cursor}` : '/api/stickers?limit=2';
      const response = await h.app.server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { stickers: Array<{ id: string }>; nextCursor: string | null };
      for (const sticker of body.stickers) {
        expect(seen.has(sticker.id)).toBe(false);
        seen.add(sticker.id);
      }
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(h.app.services.stickerLibrary.available().length);
  });
});
