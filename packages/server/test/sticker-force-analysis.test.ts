import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

async function makeManualSticker() {
  const media = await harness!.app.services.mediaStore.save({ kind: 'sticker', origin: 'upload', data: TEST_PNG, filename: 'force.png' });
  return harness!.app.repos.stickers.create({
    mediaId: media.id,
    name: '人工表情',
    tags: ['人工标签'],
    description: '这是原始人工语义，不能被普通分析覆盖',
    imageText: '人工文字',
    nameSource: 'manual',
    analysisSource: 'manual',
    analysisStatus: 'ready'
  });
}

const AI = JSON.stringify({ suggestedName: '模型表情', description: '这是模型分析出的聊天语义', imageText: '模型文字', tags: ['模型标签'] });

describe('forced sticker analysis', () => {
  it('protects manual stickers without force and replaces them with force', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, chat: { script: [[AI]] } });
    const sticker = await makeManualSticker();

    expect(await harness.app.services.stickerAnalyzer.analyze(sticker.id)).toBeNull();
    expect(harness.state.chatCalls).toHaveLength(0);
    expect(await harness.app.services.stickerAnalyzer.analyze(sticker.id, { force: true, expectedSemanticRevision: sticker.semanticRevision })).toEqual(expect.objectContaining({ suggestedName: '模型表情' }));
    expect(harness.app.repos.stickers.get(sticker.id)).toMatchObject({ analysisSource: 'ai', description: '这是模型分析出的聊天语义' });
  });

  it('drops a forced result when a manual edit advances the semantic revision', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, chat: { delayMs: 20, script: [[AI]] } });
    const sticker = await makeManualSticker();
    const pending = harness.app.services.stickerAnalyzer.analyze(sticker.id, { force: true, expectedSemanticRevision: sticker.semanticRevision });
    await new Promise((resolve) => setTimeout(resolve, 5));
    harness.app.repos.stickers.updateManualSemantics(sticker.id, { tags: ['最后人工标签'] });
    expect(await pending).toBeNull();
    expect(harness.app.repos.stickers.get(sticker.id)).toMatchObject({ analysisSource: 'manual', tags: ['最后人工标签'] });
  });

  it('keeps the original manual semantics when forced vision fails', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, chat: { chatError: new Error('vision_down') } });
    const sticker = await makeManualSticker();
    expect(await harness.app.services.stickerAnalyzer.analyze(sticker.id, { force: true, expectedSemanticRevision: sticker.semanticRevision })).toBeNull();
    expect(harness.app.repos.stickers.get(sticker.id)).toMatchObject({ analysisSource: 'manual', analysisStatus: 'ready', description: sticker.description, tags: sticker.tags });
  });

  it('shows pending and processing while force analysis runs on a manual sticker', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: 'admin-test-token' }, chat: { delayMs: 40, script: [[AI]] } });
    const sticker = await makeManualSticker();
    const queued = await harness.app.server.inject({
      method: 'POST',
      url: `/api/admin/stickers/${sticker.id}/analyze`,
      headers: { 'x-admin-token': 'admin-test-token' },
      payload: { force: true }
    });
    expect(queued.statusCode).toBe(200);
    expect(harness.app.repos.stickers.get(sticker.id)?.analysisStatus).toBe('pending');

    const running = harness.app.services.worker.drain(1);
    for (let i = 0; i < 20 && harness.app.repos.stickers.get(sticker.id)?.analysisStatus !== 'processing'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(harness.app.repos.stickers.get(sticker.id)).toMatchObject({ analysisSource: 'manual', analysisStatus: 'processing' });
    await running;
    expect(harness.app.repos.stickers.get(sticker.id)).toMatchObject({ analysisSource: 'ai', analysisStatus: 'ready' });
  });
});
