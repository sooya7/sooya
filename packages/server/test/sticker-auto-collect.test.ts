import { afterEach, describe, expect, it } from 'vitest';
import { StickerAutoCollector } from '../src/core/stickers/auto-collector.js';
import type { ChatProvider } from '../src/providers/types.js';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';

let h: Harness;
afterEach(async () => { if (h) await h.cleanup(); });

function fakeVision(decision: Record<string, unknown>, calls: { count: number }): ChatProvider {
  return {
    name: 'fake-vision',
    configured: true,
    complete: async () => {
      calls.count++;
      return { text: JSON.stringify(decision), model: 'fake-vision' };
    }
  } as ChatProvider;
}

async function candidate() {
  return h.app.services.mediaStore.save({
    kind: 'image', origin: 'remote', data: Buffer.from(TEST_PNG), declaredMime: 'image/png', filename: 'candidate.png', meta: { source: 'qq' }
  });
}

describe('StickerAutoCollector', () => {
  it('ignores generated or non-QQ images before consulting vision', async () => {
    h = await createHarness({ skipStickerImport: true });
    const source = await h.app.services.mediaStore.save({
      kind: 'image', origin: 'generated', data: Buffer.from(TEST_PNG), declaredMime: 'image/png', filename: 'generated.png'
    });
    const calls = { count: 0 };
    const collector = new StickerAutoCollector(
      h.app.repos.media, h.app.repos.stickers, h.app.services.mediaStore,
      () => fakeVision({ isSticker: true, shouldCollect: true, confidence: 1, category: 'sticker', suggestedName: '不该收', description: '不该进入收藏', imageText: '', emotion: 'neutral', tags: [], reason: '' }, calls)
    );
    const result = await collector.collect(source.id);
    expect(result.collected).toBe(false);
    expect(result.reason).toBe('not_qq_image_candidate');
    expect(calls.count).toBe(0);
    expect(h.app.repos.stickers.count(false)).toBe(0);
  });

  it('never collects an ordinary image when isSticker is false', async () => {
    h = await createHarness({ skipStickerImport: true });
    const source = await candidate();
    const calls = { count: 0 };
    const collector = new StickerAutoCollector(
      h.app.repos.media,
      h.app.repos.stickers,
      h.app.services.mediaStore,
      () => fakeVision({
        isSticker: false,
        shouldCollect: true,
        confidence: 0.99,
        category: 'photo',
        suggestedName: '普通照片',
        description: '一张普通照片，不属于聊天表情包。',
        imageText: '',
        emotion: 'neutral',
        tags: ['照片'],
        reason: 'ordinary photo'
      }, calls)
    );

    const result = await collector.collect(source.id);
    expect(result.collected).toBe(false);
    expect(result.reason).toBe('model_rejected');
    expect(h.app.repos.media.findBySha(source.sha256, 'sticker')).toBeUndefined();
    expect(h.app.repos.stickers.count(false)).toBe(0);
  });

  it('rejects uncertain candidates even when the model calls them stickers', async () => {
    h = await createHarness({ skipStickerImport: true });
    const source = await candidate();
    const calls = { count: 0 };
    const collector = new StickerAutoCollector(
      h.app.repos.media,
      h.app.repos.stickers,
      h.app.services.mediaStore,
      () => fakeVision({
        isSticker: true,
        shouldCollect: true,
        confidence: 0.91,
        category: 'sticker',
        suggestedName: '不确定表情',
        description: '看起来像表情，但把握不够高。',
        imageText: '',
        emotion: '疑惑',
        tags: ['疑惑'],
        reason: 'uncertain'
      }, calls)
    );

    const result = await collector.collect(source.id);
    expect(result.collected).toBe(false);
    expect(h.app.repos.stickers.count(false)).toBe(0);
  });

  it('collects a high-confidence reusable sticker and deduplicates future copies', async () => {
    h = await createHarness({ skipStickerImport: true });
    const source = await candidate();
    const calls = { count: 0 };
    const collector = new StickerAutoCollector(
      h.app.repos.media,
      h.app.repos.stickers,
      h.app.services.mediaStore,
      () => fakeVision({
        isSticker: true,
        shouldCollect: true,
        confidence: 0.98,
        category: 'sticker',
        suggestedName: '猫猫震惊',
        description: '夸张震惊反应图，适合聊天里表达突然被惊到。',
        imageText: '？',
        emotion: '震惊',
        tags: ['震惊', '猫猫', '反应图'],
        reason: 'clear reusable reaction'
      }, calls)
    );

    const first = await collector.collect(source.id);
    expect(first.collected).toBe(true);
    expect(first.stickerId).toBeTruthy();
    expect(h.app.repos.stickers.get(first.stickerId!)?.name).toBe('猫猫震惊');
    expect(h.app.repos.media.findBySha(source.sha256, 'sticker')?.kind).toBe('sticker');

    const second = await collector.collect(source.id);
    expect(second.collected).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(calls.count).toBe(1);
  });
});
