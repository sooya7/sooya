import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

describe('exact media reference protection', () => {
  it('counts message, sticker and avatar references without world data', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const media = harness.app.repos.media;
    for (const id of ['media_target', 'media_other']) {
      media.create({ id, kind: 'image', relPath: `${id}.png`, mime: 'image/png', bytes: 1, sha256: `${id}_sha`, origin: 'upload' });
    }

    harness.app.repos.messages.create({ role: 'user', parts: [{ type: 'image', mediaId: 'media_target', status: 'sent' }] });
    harness.app.repos.stickers.create({ id: 'sticker_ref', mediaId: 'media_target', name: '测试', tags: [], emotion: 'neutral' });
    harness.app.config.setPersona({ avatar: '/api/media/media_target' });

    expect(media.references('media_target')).toMatchObject({ messageParts: 1, stickers: 1, total: 2 });
    expect(media.listUnreferenced(100).map((row) => row.id)).not.toContain('media_target');
    expect(media.listUnreferenced(100).map((row) => row.id)).toContain('media_other');
  });
});
