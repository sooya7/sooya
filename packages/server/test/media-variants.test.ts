import fs from 'node:fs';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import type { MediaRow } from '../src/db/repos/media.repo.js';

/*
 * `GET /api/media/<id>` 以前只有原图一种响应，聊天气泡显示 300 多像素时也要先下载
 * 完整的 2 MB 原图。这些用例守住 `?w=` 缩略图的行为：命中档位要给更小的 WebP、
 * 变体要落盘复用、不适用的请求必须安全回退原图而不是报错或给出错误的字节。
 */

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.cleanup();
  h = null;
});

let bigJpeg: Buffer;
let smallPng: Buffer;

beforeAll(async () => {
  bigJpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#2f6fb0' } })
    .jpeg({ quality: 90 })
    .toBuffer();
  smallPng = await sharp({ create: { width: 120, height: 90, channels: 4, background: '#ffcc00' } })
    .png()
    .toBuffer();
});

async function seed(harness: Harness, data: Buffer, mime: string): Promise<MediaRow> {
  return harness.app.services.mediaStore.save({ kind: 'image', origin: 'upload', data, declaredMime: mime, filename: `shot.${mime.split('/')[1]}` });
}

function variantFiles(harness: Harness): string[] {
  const dir = harness.app.env.mediaDirs.variants;
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.endsWith('.tmp')).sort() : [];
}

describe('媒体缩略图变体', () => {
  it('?w=480 返回更小的 WebP，并按档位落盘缓存', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seed(h, bigJpeg, 'image/jpeg');

    const res = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=480` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.rawPayload.length).toBeLessThan(row.bytes);
    expect(Number(res.headers['content-length'])).toBe(res.rawPayload.length);
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(480);
    expect(meta.format).toBe('webp');
    // 缩略图和原图一样永不改写，所以照旧是私有长期缓存。
    expect(res.headers['cache-control']).toBe('private, max-age=604800, immutable');
    expect(variantFiles(h)).toEqual([`${row.id}-w480.webp`]);

    // 第二次请求必须命中磁盘缓存，而不是再渲染一份或多写一个文件。
    const cached = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=480` });
    expect(cached.statusCode).toBe(200);
    expect(cached.rawPayload.length).toBe(res.rawPayload.length);
    expect(variantFiles(h)).toEqual([`${row.id}-w480.webp`]);
  });

  it('请求宽度向上取到最近档位，超过最大档位回退原图', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seed(h, bigJpeg, 'image/jpeg');

    const snapped = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=300` });
    expect(snapped.statusCode).toBe(200);
    expect((await sharp(snapped.rawPayload).metadata()).width).toBe(480);
    expect(variantFiles(h)).toEqual([`${row.id}-w480.webp`]);

    const tooWide = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=4000` });
    expect(tooWide.statusCode).toBe(200);
    expect(tooWide.headers['content-type']).toBe('image/jpeg');
    expect(tooWide.rawPayload.length).toBe(row.bytes);
    expect(variantFiles(h)).toEqual([`${row.id}-w480.webp`]);
  });

  it('ETag 随宽度变化，If-None-Match 命中回 304', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seed(h, bigJpeg, 'image/jpeg');

    const small = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=240` });
    const large = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=960` });
    const original = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}` });
    const tags = [small.headers.etag, large.headers.etag, original.headers.etag];
    expect(new Set(tags).size).toBe(3);

    const revalidated = await h.app.server.inject({
      method: 'GET',
      url: `/api/media/${row.id}?w=240`,
      headers: { 'if-none-match': small.headers.etag as string }
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.rawPayload.length).toBe(0);

    // 原图的 ETag 不能让缩略图误判为未修改。
    const crossTag = await h.app.server.inject({
      method: 'GET',
      url: `/api/media/${row.id}?w=240`,
      headers: { 'if-none-match': original.headers.etag as string }
    });
    expect(crossTag.statusCode).toBe(200);
  });

  it('非法 w 回退原图而不是报错', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seed(h, bigJpeg, 'image/jpeg');

    for (const w of ['abc', '0', '-480', '480px', '', '999999']) {
      const res = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=${encodeURIComponent(w)}` });
      expect(res.statusCode, `w=${w}`).toBe(200);
      expect(res.headers['content-type'], `w=${w}`).toBe('image/jpeg');
      expect(res.rawPayload.length, `w=${w}`).toBe(row.bytes);
    }
    expect(variantFiles(h)).toEqual([]);
  });

  it('原图已经比档位更窄时不生成变体', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seed(h, smallPng, 'image/png');

    const res = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=480` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.length).toBe(row.bytes);
    expect(variantFiles(h)).toEqual([]);
  });

  it('非图片媒体带 w 时按原样下载', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await h.app.services.mediaStore.save({
      kind: 'file',
      origin: 'upload',
      data: Buffer.from('# notes\nhello thumbnails\n'),
      declaredMime: 'text/plain',
      filename: 'notes.txt'
    });

    const res = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=480` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.rawPayload.length).toBe(row.bytes);
    expect(variantFiles(h)).toEqual([]);
  });

  it('动态 WebP 记录 animated 并始终返回多帧原图', async () => {
    h = await createHarness({ startWorkers: false });
    const animated = Buffer.from(fs.readFileSync(new URL('./fixtures/animated-webp.b64', import.meta.url), 'utf8').trim(), 'base64');
    const row = await h.app.services.mediaStore.save({ kind: 'sticker', origin: 'upload', data: animated, declaredMime: 'image/webp', filename: 'animated.webp' });
    expect(row.animated).toBe(1);

    const res = await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=240` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.rawPayload).toEqual(animated);
    expect((await sharp(res.rawPayload, { animated: true }).metadata()).pages).toBeGreaterThan(1);
    expect(variantFiles(h)).toEqual([]);
  });

  it('删除媒体时一并清掉它的变体文件', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seed(h, bigJpeg, 'image/jpeg');
    await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=240` });
    await h.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=480` });
    expect(variantFiles(h)).toHaveLength(2);

    expect(await h.app.services.mediaStore.delete(row.id)).toBe(true);
    expect(variantFiles(h)).toEqual([]);
  });

  it('并发请求同一变体只渲染一次', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await seed(h, bigJpeg, 'image/jpeg');
    const results = await Promise.all(
      Array.from({ length: 4 }, () => h!.app.server.inject({ method: 'GET', url: `/api/media/${row.id}?w=960` }))
    );
    for (const res of results) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.rawPayload.length).toBe(results[0]!.rawPayload.length);
    }
    expect(variantFiles(h)).toEqual([`${row.id}-w960.webp`]);
  });
});
