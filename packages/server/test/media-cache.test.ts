import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.cleanup();
  h = null;
});

/*
 * 媒体以前是 `cache-control: private, no-store`：每次挂载都要重传整张原图，画廊一页 60 张。
 * 一个 id 的字节永远不会被改写（创建时落盘，之后只改元数据），所以强 ETag 与 immutable 是
 * 成立的；这些用例守住这个前提，以及「元数据变了不能让缓存失效」。
 */
async function seedImage(harness: Harness, bytes: Buffer) {
  return harness.app.services.mediaStore.save({
    kind: 'image',
    origin: 'upload',
    data: bytes,
    declaredMime: 'image/png',
    filename: 'shot.png'
  });
}

// 真 PNG：写入前会做内容嗅探，构造的假头会被 MediaValidationError 拒掉。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

describe('媒体缓存响应头', () => {
  it('可长期缓存并带 ETag，而不是 no-store', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seedImage(h, PNG);
    const res = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['cache-control']).toContain('private');
    // 共享缓存/CDN 绝不能存私有媒体，所以必须是 private 而不是 public。
    expect(res.headers['cache-control']).not.toContain('public');
    expect(res.headers['cache-control']).not.toContain('no-store');
    expect(res.headers.etag).toBeTruthy();
  });

  it('带 If-None-Match 时回 304 且不传正文', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seedImage(h, PNG);
    const first = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}` });
    const etag = first.headers.etag as string;
    const second = await h.app.server.inject({
      method: 'GET',
      url: `/api/media/${row.id}`,
      headers: { 'if-none-match': etag }
    });
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.length).toBe(0);
    // 多值头（浏览器会一次带上多个候选）也要能匹配上。
    const third = await h.app.server.inject({
      method: 'GET',
      url: `/api/media/${row.id}`,
      headers: { 'if-none-match': `"stale-1", ${etag}` }
    });
    expect(third.statusCode).toBe(304);
  });

  it('ETag 不匹配时照常回完整正文', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seedImage(h, PNG);
    const res = await h.app.server.inject({
      method: 'GET',
      url: `/api/media/${row.id}`,
      headers: { 'if-none-match': '"someone-elses-etag"' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(row.bytes);
  });

  it('两个不同媒体的 ETag 不同，不会互相串图', async () => {
    h = await createHarness({ startWorkers: false });
    const a = await seedImage(h, PNG);
    const b = await seedImage(h, Buffer.concat([PNG, Buffer.alloc(8, 9)]));
    const [ra, rb] = await Promise.all([
      h.app.server.inject({ method: 'GET', url: `/api/media/${a.id}` }),
      h.app.server.inject({ method: 'GET', url: `/api/media/${b.id}` })
    ]);
    expect(ra.headers.etag).not.toBe(rb.headers.etag);
    // 拿 A 的 ETag 去问 B，必须是 200 完整正文，不能被误判成未修改。
    const cross = await h.app.server.inject({
      method: 'GET',
      url: `/api/media/${b.id}`,
      headers: { 'if-none-match': ra.headers.etag as string }
    });
    expect(cross.statusCode).toBe(200);
  });

  it('改元数据（收藏、标签）不会动字节，所以缓存仍然有效', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seedImage(h, PNG);
    const before = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}` });
    h.app.repos.media.setFavorite(row.id, true);
    h.app.repos.media.setTags(row.id, ['海边']);
    const after = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}` });
    expect(after.headers.etag).toBe(before.headers.etag);
    expect(after.rawPayload.length).toBe(before.rawPayload.length);
  });

  it('Range 请求仍然可用，不被 304 分支吃掉', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seedImage(h, PNG);
    const res = await h.app.server.inject({
      method: 'GET',
      url: `/api/media/${row.id}`,
      headers: { range: 'bytes=0-7' }
    });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.length).toBe(8);
  });

  it('Range 后缀形式 bytes=-N 返回文件尾部而不是头部', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seedImage(h, PNG);
    const res = await h.app.server.inject({
      method: 'GET',
      url: `/api/media/${row.id}`,
      headers: { range: 'bytes=-5' }
    });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.length).toBe(5);
    expect(res.rawPayload.equals(PNG.subarray(PNG.length - 5))).toBe(true);
    expect(res.headers['content-range']).toBe(`bytes ${PNG.length - 5}-${PNG.length - 1}/${PNG.length}`);
  });

  it('Range bytes=-0 与越界均回 416', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seedImage(h, PNG);
    const zero = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}`, headers: { range: 'bytes=-0' } });
    expect(zero.statusCode).toBe(416);
    const past = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}`, headers: { range: `bytes=${PNG.length}-` } });
    expect(past.statusCode).toBe(416);
  });

  it('空 Range bytes=- 被忽略，回 200 全文', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seedImage(h, PNG);
    const res = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}`, headers: { range: 'bytes=-' } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(PNG.length);
  });
});
