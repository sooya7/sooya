import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

/** Create a sticker whose media file really exists on disk, so available() includes it. */
async function makeRealSticker(mediaId: string, name: string) {
  const media = await harness!.app.services.mediaStore.save({
    kind: 'sticker',
    origin: 'upload',
    data: TEST_PNG,
    filename: `${mediaId}.png`,
    meta: {}
  });
  return harness!.app.repos.stickers.create({ mediaId: media.id, name, tags: ['测试'], emotion: 'neutral' });
}

/**
 * StickerLibrary.available()/all() do a directory query + a disk stat per sticker,
 * which every reply pays (dozens of DB+stat calls). The results are cached until a
 * sticker mutation (create/update/markUsed/delete) or a media deletion invalidates it.
 */
describe('sticker library memory cache', () => {
  it('serves available()/all() from cache until invalidated', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const lib = harness.app.services.stickerLibrary;
    await makeRealSticker('media_cache_hit', '缓存贴纸');

    const listSpy = vi.spyOn(harness.app.repos.stickers, 'list');
    lib.available();
    lib.available();
    lib.all();
    lib.all();
    expect(listSpy).toHaveBeenCalledTimes(2); // once per cache slot, no re-query on hit

    lib.invalidate();
    lib.available();
    expect(listSpy).toHaveBeenCalledTimes(3);
  });

  it('re-queries after create/update/markUsed/delete via the repo change hook', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const lib = harness.app.services.stickerLibrary;

    const sticker = await makeRealSticker('media_cache_mut', '可变贴纸');
    lib.available();
    expect(lib.available().some((s) => s.id === sticker.id)).toBe(true);

    harness.app.repos.stickers.markUsed(sticker.id);
    expect(lib.available().find((s) => s.id === sticker.id)!.useCount).toBe(1);

    harness.app.repos.stickers.update(sticker.id, { tags: ['改了'] });
    expect(lib.available().find((s) => s.id === sticker.id)!.tags).toEqual(['改了']);

    harness.app.repos.stickers.delete(sticker.id);
    expect(lib.available().some((s) => s.id === sticker.id)).toBe(false);
  });

  it('invalidates when a sticker media file is deleted through the store', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const lib = harness.app.services.stickerLibrary;
    const sticker = await makeRealSticker('media_cache_del', '待删贴纸');
    expect(lib.available().some((s) => s.id === sticker.id)).toBe(true);

    await harness.app.services.mediaStore.delete(sticker.mediaId);
    expect(lib.available().some((s) => s.id === sticker.id)).toBe(false);
  });
});
