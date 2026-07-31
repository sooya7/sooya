import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };

/**
 * DELETE /api/admin/stickers/:id 曾经无条件连贴纸带媒体一起物理删除。表情发进
 * 聊天后是消息部件（message_parts.media_id 指向贴纸的媒体），媒体一没，历史消息
 * 里的表情就变成破图 —— 与媒体永久删除的 409 保护（media_is_referenced）走的是
 * 同一条「不可逆删除前先查引用」的规矩。
 */
function makeSticker(id: string, name: string) {
  harness!.app.repos.media.create({
    id,
    kind: 'sticker',
    relPath: `${id}.png`,
    mime: 'image/png',
    bytes: 1,
    sha256: `${id}_sha256`,
    origin: 'upload'
  });
  return harness!.app.repos.stickers.create({ mediaId: id, name, tags: ['测试'], emotion: 'neutral' });
}

describe('sticker delete reference protection', () => {
  it('deletes an unreferenced sticker together with its media', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const sticker = makeSticker('media_sticker_free', '自由贴纸');

    const res = await harness.app.server.inject({ method: 'DELETE', url: `/api/admin/stickers/${sticker.id}`, headers: ADMIN });

    expect(res.statusCode).toBe(200);
    expect(harness.app.repos.stickers.get(sticker.id)).toBeUndefined();
    expect(harness.app.repos.media.get('media_sticker_free')).toBeUndefined();
  });

  it('returns 409 instead of breaking history messages that sent the sticker', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const sticker = makeSticker('media_sticker_used', '历史贴纸');
    harness.app.repos.messages.create({
      role: 'assistant',
      parts: [{ type: 'sticker', mediaId: 'media_sticker_used', status: 'sent', meta: { stickerId: sticker.id, stickerName: sticker.name } }]
    });

    const res = await harness.app.server.inject({ method: 'DELETE', url: `/api/admin/stickers/${sticker.id}`, headers: ADMIN });

    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; references: { messageParts: number } };
    expect(body.error).toBe('sticker_is_referenced');
    expect(body.references.messageParts).toBe(1);
    // 贴纸与媒体都原样保留，历史消息里的表情不受影响
    expect(harness.app.repos.stickers.get(sticker.id)).toBeDefined();
    expect(harness.app.repos.media.get('media_sticker_used')).toBeDefined();
  });
});
