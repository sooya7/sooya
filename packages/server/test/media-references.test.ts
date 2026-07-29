import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };

describe('exact media reference protection', () => {
  it('counts only structured exact references across messages, stickers, avatars and world data', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const media = harness.app.repos.media;
    const world = harness.app.repos.world;
    const targetId = 'media_abc';
    const longerId = 'media_abcd';
    const assistantAvatarId = 'media_assistant_avatar';
    for (const id of [targetId, longerId, assistantAvatarId]) {
      media.create({
        id,
        kind: 'image',
        relPath: `${id}.png`,
        mime: 'image/png',
        bytes: 1,
        sha256: `${id}_sha256`,
        origin: 'upload'
      });
    }

    world.create({
      kind: 'fact',
      subject: '普通文本',
      predicate: '备注',
      object: '不应形成媒体引用',
      value: { note: `正文里提到了 ${targetId}，但不是媒体字段` }
    });
    world.create({
      kind: 'fact',
      subject: '较长媒体',
      predicate: '配图',
      object: longerId,
      value: { mediaId: longerId }
    });
    const disabledWorld = world.create({
      kind: 'fact',
      subject: '已禁用媒体',
      predicate: '配图',
      object: targetId,
      value: { mediaId: targetId }
    });
    world.update(disabledWorld.id, { active: false });
    const malformedWorld = world.create({
      kind: 'fact',
      subject: '损坏旧数据',
      predicate: '兼容',
      object: '无引用',
      value: {}
    });
    harness.app.db.prepare('UPDATE world_entries SET value_json = ? WHERE id = ?').run('{broken', malformedWorld.id);

    expect(media.references(targetId).worldEntries).toBe(0);
    expect(media.listUnreferenced(100).map((row) => row.id)).toContain(targetId);
    harness.app.db.prepare('UPDATE media SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', targetId);
    expect(media.listOrphanUploads('2020-01-01T00:00:00.000Z', 100).map((row) => row.id)).toContain(targetId);

    const exactWorld = world.create({
      kind: 'fact',
      subject: '精确媒体',
      predicate: '配图',
      object: targetId,
      value: { nested: { mediaId: targetId } }
    });
    expect(media.references(targetId).worldEntries).toBe(1);
    expect(media.listUnreferenced(100).map((row) => row.id)).not.toContain(targetId);
    expect(media.listOrphanUploads('2020-01-01T00:00:00.000Z', 100).map((row) => row.id)).not.toContain(targetId);
    const message = harness.app.repos.messages.create({
      role: 'user',
      parts: [{ type: 'image', mediaId: targetId, status: 'sent' }]
    });
    const sticker = harness.app.repos.stickers.create({
      id: 'sticker_exact_media_ref',
      mediaId: targetId,
      name: '精确引用测试贴纸',
      tags: ['测试'],
      emotion: 'neutral'
    });
    harness.app.config.setPersona({
      avatar: `/api/media/${assistantAvatarId}`,
      userAvatar: `/api/media/${targetId}`
    });

    expect(media.references(targetId)).toMatchObject({
      messageParts: 1,
      stickers: 1,
      worldEntries: 1,
      total: 3
    });
    expect(harness.app.services.storage.isAvatarMedia(targetId)).toBe(true);
    expect(harness.app.services.storage.isAvatarMedia(assistantAvatarId)).toBe(true);
    expect((await harness.app.server.inject({
      method: 'DELETE',
      url: `/api/admin/media/${targetId}/permanent`,
      headers: ADMIN
    })).statusCode).toBe(409);
    expect((await harness.app.server.inject({
      method: 'DELETE',
      url: `/api/admin/media/${assistantAvatarId}/permanent`,
      headers: ADMIN
    })).statusCode).toBe(409);

    harness.app.repos.messages.clearAll();
    harness.app.repos.stickers.delete(sticker.id);
    world.update(exactWorld.id, { active: false });
    harness.app.config.setPersona({ avatar: '/avatars/sooya.svg', userAvatar: '/avatars/user.svg' });

    expect(media.references(targetId).total).toBe(0);
    expect((await harness.app.server.inject({
      method: 'DELETE',
      url: `/api/admin/media/${targetId}/permanent`,
      headers: ADMIN
    })).statusCode).toBe(200);
    expect(media.get(targetId)).toBeUndefined();
    expect(message.created).toBe(true);
  });
});
