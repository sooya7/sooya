import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

async function makeSticker(name = '无语小猫') {
  const media = await harness!.app.services.mediaStore.save({
    kind: 'sticker',
    origin: 'upload',
    data: TEST_PNG,
    filename: `${name}.png`,
    meta: {}
  });
  return harness!.app.repos.stickers.create({
    mediaId: media.id,
    name,
    emotion: '无语',
    tags: ['无语', '猫'],
    description: '面对离谱事情时，带一点吐槽和无奈的反应',
    imageText: '唉',
    nameSource: 'manual',
    analysisSource: 'manual',
    analysisStatus: 'ready'
  });
}

describe('Sticker V2 semantics and user surface', () => {
  it('keeps canonical semantic text searchable and supports scoped lists', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const sticker = await makeSticker();

    expect(harness.app.repos.stickers.searchFts('无语').map((item) => item.id)).toContain(sticker.id);
    harness.app.repos.stickers.setFavorite(sticker.id, true);
    expect(harness.app.repos.stickers.list({ scope: 'favorite' }).map((item) => item.id)).toContain(sticker.id);
    expect(harness.app.services.stickerLibrary.semanticText(sticker)).toContain('面对离谱事情');
  });

  it('returns semantic fields, toggles favorites, and records user sticker use', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const sticker = await makeSticker('收藏测试');

    const listed = await harness.app.server.inject({ method: 'GET', url: '/api/stickers?q=收藏' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().stickers[0]).toMatchObject({ id: sticker.id, description: expect.stringContaining('面对离谱'), imageText: '唉' });

    const favorite = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/stickers/${sticker.id}/preferences`,
      payload: { favorite: true }
    });
    expect(favorite.statusCode).toBe(200);
    expect(favorite.json().sticker.favorite).toBe(true);

    const sent = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: { clientMsgId: 'sticker-v2-user-use', content: [{ type: 'sticker', mediaId: sticker.mediaId }] }
    });
    expect(sent.statusCode).toBe(200);
    expect(harness.app.repos.stickers.get(sticker.id)?.userUseCount).toBe(1);
  });

  it('lets admins query disabled stickers explicitly without exposing them to chat', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const sticker = await makeSticker('禁用测试');
    harness.app.repos.stickers.update(sticker.id, { enabled: false });

    const admin = await harness.app.server.inject({ method: 'GET', url: '/api/admin/stickers?enabled=false', headers: { 'x-admin-token': 'admin-test-token' } });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().stickers.map((item: { id: string }) => item.id)).toContain(sticker.id);

    const user = await harness.app.server.inject({ method: 'GET', url: '/api/stickers' });
    expect(user.json().stickers.map((item: { id: string }) => item.id)).not.toContain(sticker.id);
  });

  it('keeps manual meaning timestamps and source semantics canonical', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const sticker = await makeSticker('语义保护');

    const manual = harness.app.repos.stickers.setUserMeaning(sticker.id, '这是我给它的备注', 'manual', 0.7)!;
    expect(manual.userMeaningSource).toBe('manual');
    expect(manual.userMeaningConfidence).toBeNull();
    expect(manual.userMeaningUpdatedAt).toBeTruthy();

    const cleared = harness.app.repos.stickers.setUserMeaning(sticker.id, '   ', 'manual', 0.9)!;
    expect(cleared.userMeaning).toBe('');
    expect(cleared.userMeaningSource).toBe('none');
    expect(cleared.userMeaningConfidence).toBeNull();
    expect(cleared.userMeaningUpdatedAt).toBeNull();

    const ai = harness.app.repos.stickers.setUserMeaning(sticker.id, '模型备注', 'ai', 0.83)!;
    expect(ai.userMeaningSource).toBe('ai');
    expect(ai.userMeaningConfidence).toBe(0.83);
  });

  it('marks manual semantic edits ready and fences a stale AI result', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    const media = await harness.app.services.mediaStore.save({ kind: 'sticker', origin: 'upload', data: TEST_PNG, filename: 'manual-description.png' });
    const sticker = harness.app.repos.stickers.create({ mediaId: media.id, name: '人工描述', description: '旧的模型语义', analysisSource: 'ai', analysisStatus: 'processing' });
    const updated = harness.app.repos.stickers.updateManualSemantics(sticker.id, { tags: ['人工标签'] })!;
    expect(updated.analysisSource).toBe('manual');
    expect(updated.analysisStatus).toBe('ready');
    expect(updated.analysisError).toBeNull();

    const result = harness.app.repos.stickers.applyAiAnalysis(
      sticker.id,
      { suggestedName: '模型名', description: '模型不应覆盖这段人工语义', imageText: '', tags: ['模型标签'] },
      { version: 2, model: 'test' }
    )!;
    expect(result.analysisSource).toBe('manual');
    expect(result.tags).toEqual(['人工标签']);
  });
});
