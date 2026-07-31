import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import type { SooyaApp } from '../app.js';
import { requireChatToken } from './auth.js';
import { MediaValidationError } from '../media/store.js';
import { PathTraversalError } from '../util/fsx.js';
import { toMediaRef } from '../db/repos/media.repo.js';

const KIND_BY_FIELD: Record<string, 'image' | 'audio' | 'file'> = { image: 'image', images: 'image', audio: 'audio', voice: 'audio', file: 'file', files: 'file' };

export function registerMediaRoutes(app: SooyaApp): void {
  const { server, services, repos, env } = app;
  const auth = requireChatToken(app);

  server.post('/api/media', { preHandler: auth }, async (req, reply) => {
    if (!req.isMultipart()) { reply.code(400); return { error: 'expected_multipart' }; }
    const saved: unknown[] = [];
    const failed: Array<{ filename: string; error: string; code?: string }> = [];
    let count = 0;
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        count++;
        if (count > env.MAX_UPLOAD_FILES) { failed.push({ filename: part.filename ?? 'unknown', error: 'too many files', code: 'TOO_MANY_FILES' }); break; }
        let buffer: Buffer;
        try { buffer = await part.toBuffer(); }
        catch (err) { const error = err as Error & { code?: string }; failed.push({ filename: part.filename ?? 'unknown', error: error.code === 'FST_REQ_FILE_TOO_LARGE' ? 'file too large' : error.message, code: error.code === 'FST_REQ_FILE_TOO_LARGE' ? 'TOO_LARGE' : 'READ_FAILED' }); continue; }
        const kind = KIND_BY_FIELD[part.fieldname] ?? guessKind(part.mimetype);
        const durationField = (part.fields?.duration as { value?: string } | undefined)?.value;
        try {
          await services.storage.assertWritable(buffer.length);
          const row = await services.mediaStore.save({ kind, origin: 'upload', data: buffer, declaredMime: part.mimetype, filename: sanitizeFilename(part.filename), durationHint: durationField ? Number(durationField) : null });
          saved.push(toMediaRef(row));
        } catch (err) {
          const error = err as MediaValidationError & { code?: string };
          failed.push({ filename: part.filename ?? 'unknown', error: error.message, code: error.code ?? 'SAVE_FAILED' });
        }
      }
    } catch (err) {
      const error = err as Error & { code?: string };
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') { reply.code(413); return { error: 'file_too_large', limit: env.MAX_UPLOAD_BYTES }; }
      throw err;
    }
    if (!saved.length && failed.length) { reply.code(failed.some((item) => item.code === 'STORAGE_HARD_LIMIT') ? 507 : 415); return { media: [], failed }; }
    return { media: saved, failed };
  });

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
    const etag = `"${id}-${stat.size}"`;
    void reply
      .header('content-type', row.mime)
      .header('cache-control', 'private, max-age=604800, immutable')
      .header('etag', etag)
      .header('accept-ranges', 'bytes')
      .header('x-content-type-options', 'nosniff');
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').some((candidate) => candidate.trim() === etag)) {
      reply.code(304);
      return reply.send();
    }
    if (row.kind === 'file') void reply.header('content-disposition', `attachment; filename="${encodeURIComponent(row.rel_path)}"`);
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) { const start = match[1] ? Number(match[1]) : 0; const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1; if (start >= stat.size || start > end) { reply.code(416).header('content-range', `bytes */${stat.size}`); return reply.send(); } void reply.code(206).header('content-range', `bytes ${start}-${end}/${stat.size}`).header('content-length', String(end - start + 1)); return reply.send(streamFile(located.path, app, { start, end })); }
    }
    void reply.header('content-length', String(stat.size));
    return reply.send(streamFile(located.path, app));
  });

  server.get('/api/media/:id/meta', { preHandler: auth }, async (req, reply) => { const row = repos.media.get((req.params as { id: string }).id); if (!row) { reply.code(404); return { error: 'not_found' }; } return { media: toMediaRef(row), exists: services.mediaStore.exists(row) }; });
  server.post('/api/media/:id/transcribe', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id; const stt = services.capabilities.sttProvider();
    if (!stt.configured) { reply.code(503); return { error: 'stt_not_configured' }; }
    const found = await services.mediaStore.read(id); if (!found) { reply.code(404); return { error: 'not_found' }; }
    try { const result = await stt.transcribe(found.data, { mime: found.row.mime, filename: found.row.rel_path }); repos.media.setTranscript(id, result.text); return { transcript: result.text, duration: result.durationSec ?? found.row.duration }; }
    catch (err) { repos.errors.add('stt', (err as Error).message); reply.code(502); return { error: 'transcription_failed', message: (err as Error).message.slice(0, 200) }; }
  });
}

function streamFile(path: string, app: SooyaApp, range?: { start: number; end: number }) {
  const stream = range ? createReadStream(path, range) : createReadStream(path);
  // Without a listener an fs read error becomes an unhandled 'error' event and the
  // response never finishes; the client then hangs instead of failing fast.
  stream.on('error', (err) => { app.repos.errors.add('media.stream', (err as Error).message, { path: path.slice(-64) }); stream.destroy(); });
  return stream;
}

function guessKind(mime?: string): 'image' | 'audio' | 'file' { if (!mime) return 'file'; if (mime.startsWith('image/')) return 'image'; if (mime.startsWith('audio/') || mime === 'video/webm') return 'audio'; return 'file'; }
function sanitizeFilename(name?: string): string | undefined { return name ? name.replace(/[\\/\0]/g, '_').slice(0, 120) : undefined; }
