import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';
import { PathTraversalError } from '../util/fsx.js';
import { toMediaRef } from '../db/repos/media.repo.js';
import { resolveVariantWidth } from '../media/variants.js';

export function registerMediaRoutes(app: SooyaApp): void {
  const { server, services, repos } = app;
  const auth = requireAdminToken(app);

  server.get('/api/media/:id', { preHandler: auth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { reply.code(400); return { error: 'bad_id' }; }
    let located: ReturnType<typeof services.mediaStore.streamPath> = null;
    try { located = services.mediaStore.streamPath(id); }
    catch (err) { if (err instanceof PathTraversalError) { reply.code(400); return { error: 'bad_path' }; } throw err; }
    if (!located) { reply.code(404); return { error: 'not_found' }; }
    const row = located.row; const stat = fs.statSync(located.path); const range = req.headers.range;
    // A generated image is announced over the stream as soon as its row exists, which
    // can be a beat before the last byte is on disk. Serving that file anyway sends a
    // body shorter than content-length, the browser aborts the read, and the client
    // reports "媒体内容读取失败" permanently. Report it as not-yet-there instead: the
    // client already treats 404 as retriable.
    if (stat.size === 0 || (row.bytes > 0 && stat.size !== row.bytes)) {
      reply.code(404);
      return { error: 'not_ready', expected: row.bytes, available: stat.size };
    }
    /*
     * 一个 id 的字节永远不会被改写：写盘只发生在创建时，之后的 UPDATE 只碰元数据
     * （收藏、标签、转写、回收站）。所以这里可以给强 ETag 和 immutable，让浏览器
     * 复用本地副本——之前的 no-store 意味着每次挂载都要重传整张原图，画廊一页 60 张。
     * private 保证只有本人的浏览器缓存，不会落到任何共享缓存/CDN 上。
     */
    /*
     * `?w=` 请求缩略图：聊天气泡和画廊只显示几百像素，原图动辄 2 MB。变体落盘复用，
     * 宽度不合法、不是可缩放的图片或原图本来就更小时，回退成原图而不是报错。
     */
    const requestedWidth = resolveVariantWidth((req.query as { w?: string }).w);
    const variant = requestedWidth === null ? null : await services.mediaVariants.get(row, located.path, requestedWidth);
    const servePath = variant?.path ?? located.path;
    const serveSize = variant?.bytes ?? stat.size;
    const etag = variant ? `"${id}-w${variant.width}-${serveSize}"` : `"${id}-${stat.size}"`;
    void reply
      .header('content-type', variant?.mime ?? row.mime)
      .header('cache-control', 'private, max-age=604800, immutable')
      .header('etag', etag)
      .header('x-content-type-options', 'nosniff');
    if (!variant) void reply.header('accept-ranges', 'bytes');
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').some((candidate) => candidate.trim() === etag)) {
      reply.code(304);
      return reply.send();
    }
    if (row.kind === 'file') void reply.header('content-disposition', `attachment; filename="${encodeURIComponent(row.rel_path)}"`);
    if (variant) {
      // 变体只有几十 KB，没有分段续传的必要；一次发完比维护两套 range 逻辑更安全。
      void reply.header('content-length', String(serveSize));
      return reply.send(streamFile(servePath, app));
    }
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match && !(match[1] === '' && match[2] === '')) {
        const size = stat.size;
        let start: number;
        let end: number;
        if (match[1] === '') {
          // 后缀范围 bytes=-N：取文件最后 N 字节，不是前缀。
          const n = Number(match[2]);
          if (n <= 0) { reply.code(416).header('content-range', `bytes */${size}`); return reply.send(); }
          start = Math.max(0, size - n);
          end = size - 1;
        } else {
          start = Number(match[1]);
          end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
        }
        if (start >= size || start > end) { reply.code(416).header('content-range', `bytes */${size}`); return reply.send(); }
        void reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', String(end - start + 1));
        return reply.send(streamFile(located.path, app, { start, end }));
      }
    }
    void reply.header('content-length', String(stat.size));
    return reply.send(streamFile(located.path, app));
  });

  server.get('/api/media/:id/meta', { preHandler: auth }, async (req, reply) => { const row = repos.media.get((req.params as { id: string }).id); if (!row) { reply.code(404); return { error: 'not_found' }; } const text = repos.mediaText.get(row.id); return { media: { ...toMediaRef(row), textStatus: text?.status, textError: text?.error ?? null }, text: text ? { status: text.status, value: text.text, metadata: text.metadata_json, error: text.error } : null, exists: services.mediaStore.exists(row) }; });
}

function streamFile(path: string, app: SooyaApp, range?: { start: number; end: number }) {
  const stream = range ? createReadStream(path, range) : createReadStream(path);
  // Without a listener an fs read error becomes an unhandled 'error' event and the
  // response never finishes; the client then hangs instead of failing fast.
  stream.on('error', (err) => { app.repos.errors.add('media.stream', (err as Error).message, { path: path.slice(-64) }); stream.destroy(); });
  return stream;
}
