import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';
import type { DirectorClient } from '../src/core/director/client.js';
import { StickerPicker } from '../src/core/stickers/picker.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('required sticker repeat fallback', () => {
  it('uses the relaxed exclusion list for validation after retrieval is relaxed', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const media = await harness.app.services.mediaStore.save({ kind: 'sticker', origin: 'upload', data: TEST_PNG, filename: 'required.png' });
    const sticker = harness.app.repos.stickers.create({ mediaId: media.id, name: '必选表情', description: '用于测试必选表情回退', analysisSource: 'manual', analysisStatus: 'ready' });
    const retrieve = vi.fn(async (_intent: string, excluded: string[]) => excluded.length
      ? { candidates: [], strategy: 'all' as const }
      : { candidates: [sticker], strategy: 'all' as const });
    const run = vi.fn().mockResolvedValue({ data: { stickerId: sticker.id, confidence: 0.9 }, model: 'test', latencyMs: 1 });
    const picker = new StickerPicker(
      { run } as unknown as DirectorClient,
      { retrieve } as never
    );

    const result = await picker.pick({
      intent: '需要一个回应',
      userText: '继续',
      assistantText: '好',
      recentContext: '',
      excludeIds: [sticker.id],
      required: true
    });

    expect(retrieve).toHaveBeenNthCalledWith(1, '需要一个回应', [sticker.id]);
    expect(retrieve).toHaveBeenNthCalledWith(2, '需要一个回应', []);
    expect(result.stickerId).toBe(sticker.id);
  });
});
