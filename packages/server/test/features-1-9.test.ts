import fs from 'node:fs';
import path from 'node:path';
import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, TEST_PNG, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => { if (harness) { await harness.cleanup(); harness = null; } });
function base64url(value: Buffer): string { return value.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
const ADMIN = { 'x-admin-token': 'admin-test-token' };

describe('SOOYA 1-9 feature regressions', () => {
  it('keeps higher-authority world facts active and excludes disabled conflicts from context', async () => {
    harness = await createHarness();
    const world = harness.app.repos.world;
    expect(world.apply([{ kind: 'fact', subject: '天空', predicate: '颜色', object: '蓝色', authority: 'user', confidence: 0.9 }], null).stored).toBe(1);
    const modelConflict = world.apply([{ kind: 'fact', subject: '天空', predicate: '颜色', object: '红色', authority: 'model', confidence: 0.99 }], null);
    expect(modelConflict.conflicts).toBe(1);
    expect(modelConflict.entries[0]?.active).toBe(0);
    expect(world.relevant('天空颜色')[0]?.object).toBe('蓝色');
    const adminWinner = world.apply([{ kind: 'fact', subject: '天空', predicate: '颜色', object: '金色', authority: 'admin', confidence: 0.8 }], null);
    const winner = adminWinner.entries[0]!;
    expect(adminWinner.conflicts).toBe(1);
    expect(winner.active).toBe(1);
    expect(winner.conflict_of).toBeNull();
    expect(world.relevant('天空颜色')[0]?.object).toBe('金色');
    expect(harness.app.services.world.contextFor('天空')).toContain('金色');
    world.update(winner.id, { active: false });
    expect(harness.app.services.world.contextFor('天空')).not.toContain('金色');
  });

  it('persists reply targets and withdraws by preserving a visible placeholder', async () => {
    harness = await createHarness();
    const first = await sendText(harness.app, '第一条消息', 'c_first');
    expect(first.res.statusCode).toBe(200);
    const firstId = (first.body.message as { id: string }).id;
    const second = await harness.app.server.inject({ method: 'POST', url: '/api/messages/sync', payload: { clientMsgId: 'c_reply', replyTo: firstId, content: [{ type: 'text', text: '这是引用回复' }] } });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { message: { id: string; replyTo: string } };
    expect(secondBody.message.replyTo).toBe(firstId);
    const withdrawn = await harness.app.server.inject({ method: 'POST', url: `/api/messages/${secondBody.message.id}/withdraw` });
    expect(withdrawn.statusCode).toBe(200);
    const message = (withdrawn.json() as { message: { content: Array<{ text?: string }>; meta: Record<string, unknown> } }).message;
    expect(message.content).toHaveLength(1);
    expect(message.content[0]?.text).toBe('[消息已撤回]');
    expect(message.meta.withdrawnAt).toBeTruthy();
  });

  it('moves gallery media to trash, restores favorites, and blocks referenced permanent deletion', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const row = await harness.app.services.mediaStore.save({ kind: 'image', origin: 'upload', data: TEST_PNG, declaredMime: 'image/png', filename: 'gallery.png' });
    expect(harness.app.repos.media.trash(row.id)).toBe(true);
    expect(harness.app.repos.media.listGallery({ deleted: true }).some((item) => item.id === row.id)).toBe(true);
    expect(harness.app.repos.media.restore(row.id)).toBe(true);
    expect(harness.app.repos.media.setFavorite(row.id, true)).toBe(true);
    expect(harness.app.repos.media.listGallery({ favorite: true }).some((item) => item.id === row.id)).toBe(true);
    harness.app.repos.messages.create({ role: 'user', parts: [{ type: 'image', mediaId: row.id, status: 'sent' }] });
    const response = await harness.app.server.inject({ method: 'DELETE', url: `/api/admin/media/${row.id}/permanent`, headers: ADMIN });
    expect(response.statusCode).toBe(409);
    expect(harness.app.repos.media.get(row.id)).toBeTruthy();
  });

  it('keeps cleanup preview non-destructive and enforces the media hard limit without breaking text chat', async () => {
    harness = await createHarness();
    const orphan = path.join(harness.app.env.mediaDir, 'orphan.bin');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, Buffer.from('orphan'));
    const preview = await harness.app.services.storage.cleanup({ apply: false });
    expect(preview.applied).toBe(false);
    expect(fs.existsSync(orphan)).toBe(true);
    expect(preview.report.candidates.orphanFiles.some((item) => item.path === orphan)).toBe(true);
    const filler = path.join(harness.app.env.mediaDir, 'quota-sparse.bin');
    const fd = fs.openSync(filler, 'w');
    fs.ftruncateSync(fd, 940 * 1024 * 1024);
    fs.closeSync(fd);
    await expect(harness.app.services.storage.assertWritable(20 * 1024 * 1024)).rejects.toMatchObject({ code: 'STORAGE_HARD_LIMIT' });
    const text = await sendText(harness.app, '空间不足时文本仍可聊天', 'c_text_under_quota');
    expect(text.res.statusCode).toBe(200);
  });

  it('removes invalid push endpoints after 404 and previews TTS without polluting chat history', async () => {
    harness = await createHarness({ tts: 'ok', env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    harness.app.services.push.subscribe({ endpoint: 'https://push.example.invalid/subscription', keys: { p256dh: base64url(ecdh.getPublicKey()), auth: base64url(randomBytes(16)) } });
    expect(harness.app.repos.pushSubscriptions.count()).toBe(1);
    const summary = await harness.app.services.push.send({ title: 'test', body: 'test' });
    expect(summary.removed).toBe(1);
    expect(harness.app.repos.pushSubscriptions.count()).toBe(0);
    const before = harness.app.repos.messages.count();
    const preview = await harness.app.server.inject({ method: 'POST', url: '/api/admin/voice/preview', headers: ADMIN, payload: { text: '温柔地说一句话', emotion: 'gentle' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('audio');
    expect(harness.app.repos.messages.count()).toBe(before);
  });
});
