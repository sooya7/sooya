import type { SooyaApp } from '../../src/app.js';
import { MediaValidationError } from '../../src/media/store.js';
import { toMediaRef } from '../../src/db/repos/media.repo.js';

const KIND_BY_FIELD: Record<string, 'image' | 'file'> = { image: 'image', images: 'image', file: 'file', files: 'file' };

/** Test-only upload surface. Production Web chat upload is removed. */
export function registerLegacyMediaUploadRoute(app: SooyaApp): void {
  const { server, services, repos, env } = app;
  server.post('/api/media', async (req, reply) => {
    if (!req.isMultipart()) { reply.code(400); return { error: 'expected_multipart' }; }
    const saved: unknown[] = [];
    const failed: Array<{ filename: string; error: string; code?: string }> = [];
    let count = 0;
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        count++;
        if (count > env.MAX_UPLOAD_FILES) { failed.push({ filename: part.filename ?? 'unknown', error: 'too many files', code: 'TOO_MANY_FILES' }); part.file.resume(); continue; }
        let buffer: Buffer;
        try { buffer = await part.toBuffer(); }
        catch (err) { const error = err as Error & { code?: string }; failed.push({ filename: part.filename ?? 'unknown', error: error.code === 'FST_REQ_FILE_TOO_LARGE' ? 'file too large' : error.message, code: error.code === 'FST_REQ_FILE_TOO_LARGE' ? 'TOO_LARGE' : 'READ_FAILED' }); continue; }
        const kind = KIND_BY_FIELD[part.fieldname];
        if (!kind) {
          failed.push({ filename: part.filename ?? 'unknown', error: 'unsupported upload field', code: 'UNSUPPORTED_FIELD' });
          continue;
        }
        try {
          await services.storage.assertWritable(buffer.length);
          const row = await services.mediaStore.save({ kind, origin: 'upload', data: buffer, declaredMime: part.mimetype, filename: sanitizeFilename(part.filename) });
          if (kind === 'file') {
            repos.mediaText.upsert({ mediaId: row.id, status: 'pending', metadata: { filename: sanitizeFilename(part.filename) ?? null } });
            repos.jobs.enqueue('media.extract_text', { mediaId: row.id }, { maxAttempts: 2 });
          }
          saved.push({ ...toMediaRef(row), ...(kind === 'file' ? { textStatus: 'pending' as const } : {}) });
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

}

function sanitizeFilename(name?: string): string | undefined { return name ? name.replace(/[\\/\0]/g, '_').slice(0, 120) : undefined; }
