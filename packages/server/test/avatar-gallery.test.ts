import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => { if (harness) { await harness.cleanup(); harness = null; } });

const ADMIN = { 'x-admin-token': 'admin-test-token' };

/** 手搓一份 multipart 体：仓库里没有别的服务端上传测试，没有现成 helper。 */
function multipartFile(field: string, filename: string, data: Buffer, mime: string) {
  const boundary = `----sooya${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { ...ADMIN, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

interface GalleryBody { media: Array<{ id: string }>; stats: { count: number; bytes: number }; total: number }

async function gallery(app: Harness['app'], query = ''): Promise<GalleryBody> {
  const res = await app.server.inject({ method: 'GET', url: `/api/admin/gallery${query}`, headers: ADMIN });
  expect(res.statusCode).toBe(200);
  return res.json() as GalleryBody;
}

async function uploadAvatar(app: Harness['app'], slot: 'assistant' | 'user', filename = `${slot}.png`) {
  const res = await app.server.inject({ method: 'POST', url: `/api/admin/persona/avatar/${slot}`, ...multipartFile('file', filename, TEST_PNG, 'image/png') });
  expect(res.statusCode).toBe(200);
  return (res.json() as { persona: { avatar: string; userAvatar: string }; media: { id: string } });
}

describe('头像图片与图库分离', () => {
  it('上传的头像不进图库，普通上传的图片仍在图库里', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const app = harness.app;
    // 走普通上传接口，顺带钉住 e2e 用来种图库数据的契约（字段名 image、返回 media 数组）。
    const uploadRes = await app.server.inject({ method: 'POST', url: '/api/media', ...multipartFile('image', 'chat.png', TEST_PNG, 'image/png') });
    expect(uploadRes.statusCode).toBe(200);
    const uploadBody = uploadRes.json() as { media: Array<{ id: string; bytes: number }> };
    expect(uploadBody.media).toHaveLength(1);
    const chatImage = uploadBody.media[0]!;

    const assistant = await uploadAvatar(app, 'assistant');
    const user = await uploadAvatar(app, 'user');
    expect(assistant.persona.avatar).toContain(assistant.media.id);
    expect(user.persona.userAvatar).toContain(user.media.id);

    const body = await gallery(app);
    const ids = body.media.map((item) => item.id);
    expect(ids).toContain(chatImage.id);
    expect(ids).not.toContain(assistant.media.id);
    expect(ids).not.toContain(user.media.id);
    // 统计口径要和列表一致，否则「N 张」会把头像算进去。
    expect(body.stats.count).toBe(1);
    expect(body.stats.bytes).toBe(chatImage.bytes);
    // 头像仍是 media 行：/api/media/<id> 要靠它出图，只是不进图库视图。
    expect(app.repos.media.get(assistant.media.id)).toBeTruthy();
    expect(body.total).toBeGreaterThanOrEqual(3);
  });

  it('头像仍可通过 avatar=1 显式列出，且不受图库筛选影响地保持独立', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const app = harness.app;
    const chatImage = await app.services.mediaStore.save({ kind: 'image', origin: 'upload', data: TEST_PNG, declaredMime: 'image/png', filename: 'chat.png' });
    const assistant = await uploadAvatar(app, 'assistant');

    const only = await gallery(app, '?avatar=1');
    const ids = only.media.map((item) => item.id);
    expect(ids).toEqual([assistant.media.id]);
    expect(ids).not.toContain(chatImage.id);
    expect(only.stats.count).toBe(1);
  });

  it('换头像后被回收的旧头像也不出现在回收站视图里', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const app = harness.app;
    const first = await uploadAvatar(app, 'assistant', 'first.png');
    const second = await uploadAvatar(app, 'assistant', 'second.png');
    expect(second.media.id).not.toBe(first.media.id);
    // 换头像会把没人引用的旧头像移入回收站。
    expect(app.repos.media.get(first.media.id)?.deleted_at).toBeTruthy();

    const trash = await gallery(app, '?trash=1');
    expect(trash.media.map((item) => item.id)).not.toContain(first.media.id);
    // 排查时可以显式查：头像 + 回收站。
    const trashedAvatars = await gallery(app, '?trash=1&avatar=1');
    expect(trashedAvatars.media.map((item) => item.id)).toEqual([first.media.id]);
  });

  it('历史上已经混进图库的头像记录也会被排除，无需数据迁移', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const app = harness.app;
    // 模拟修复前写入的旧头像行：判定只看 meta.avatar，所以老数据自动生效。
    const legacy = app.repos.media.create({ kind: 'image', relPath: 'legacy.png', mime: 'image/png', bytes: 68, sha256: 'a'.repeat(64), origin: 'upload', meta: { avatar: 'user', name: 'legacy.png' } });
    // meta_json 坏掉的行不能让 json_extract 抛错，只能当成普通图片。
    const broken = app.repos.media.create({ kind: 'image', relPath: 'broken.png', mime: 'image/png', bytes: 68, sha256: 'b'.repeat(64), origin: 'upload' });
    app.db.prepare('UPDATE media SET meta_json = ? WHERE id = ?').run('not json', broken.id);

    const ids = (await gallery(app)).media.map((item) => item.id);
    expect(ids).not.toContain(legacy.id);
    expect(ids).toContain(broken.id);
  });

  it('孤儿上传回收仍跳过头像，但不再把名字里带 avatar 的普通图片当头像', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const app = harness.app;
    const avatar = await uploadAvatar(app, 'user');
    const named = await app.services.mediaStore.save({ kind: 'image', origin: 'upload', data: TEST_PNG, declaredMime: 'image/png', filename: 'avatar' });

    const cutoff = new Date(Date.now() + 60_000).toISOString();
    const orphans = app.repos.media.listOrphanUploads(cutoff).map((row) => row.id);
    expect(orphans).not.toContain(avatar.media.id);
    expect(orphans).toContain(named.id);
  });
});
