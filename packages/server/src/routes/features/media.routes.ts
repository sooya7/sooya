import { z } from 'zod';
import type { SooyaApp } from '../../app.js';
import { requireAdminToken } from '../auth.js';
import { toMediaRef, type MediaRow } from '../../db/repos/media.repo.js';
import { DEFAULT_VOICE_EMOTIONS, resolveVoiceDelivery, type VoiceEmotionMap } from '../../core/voice.js';
import { fishCueForMood } from '../../core/voice/fishCue.js';
import { MediaValidationError } from '../../media/store.js';
import { ADMIN_MEDIA_KIND_BY_FIELD, galleryItem, IdSchema, sanitizeName } from './shared.js';

export function registerMediaFeatureRoutes(app: SooyaApp): void {
  const { server, repos, services, config, env } = app;
  const admin = requireAdminToken(app);
  const adminGuard = { preHandler: admin };

  server.post('/api/admin/media', adminGuard, async (req, reply) => {
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
        const kind = ADMIN_MEDIA_KIND_BY_FIELD[part.fieldname];
        if (!kind) {
          failed.push({ filename: part.filename ?? 'unknown', error: 'unsupported upload field', code: 'UNSUPPORTED_FIELD' });
          continue;
        }
        try {
          await services.storage.assertWritable(buffer.length);
          const row = await services.mediaStore.save({ kind, origin: 'upload', data: buffer, declaredMime: part.mimetype, filename: part.filename ? sanitizeName(part.filename) : undefined });
          repos.audit.add('media', 'admin.imported', row.id, { kind });
          if (kind === 'file') {
            repos.mediaText.upsert({ mediaId: row.id, status: 'pending', metadata: { filename: part.filename ? sanitizeName(part.filename) : null } });
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

  server.get('/api/admin/gallery', adminGuard, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const deleted = q.trash === '1' || q.trash === 'true';
    const origin = ['upload', 'generated', 'builtin', 'remote'].includes(q.origin ?? '') ? q.origin as MediaRow['origin'] : undefined;
    const query = {
      limit: Number(q.limit ?? 60),
      offset: Number(q.offset ?? 0),
      kind: 'image' as const,
      origin,
      deleted,
      favorite: q.favorite === '1' || q.favorite === 'true',
      search: q.search,
      from: q.from,
      to: q.to,
      avatar: q.avatar === '1' || q.avatar === 'true'
    };
    const rows = repos.media.listGallery(query);
    return { media: rows.map((row) => galleryItem(app, row)), stats: repos.media.galleryStats(query), total: repos.media.count() };
  });

  server.patch('/api/admin/media/:id', adminGuard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!IdSchema.test(id) || !repos.media.get(id)) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const parsed = z.object({ favorite: z.boolean().optional(), tags: z.array(z.string().max(60)).max(30).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    if (parsed.data.favorite !== undefined) repos.media.setFavorite(id, parsed.data.favorite);
    if (parsed.data.tags) repos.media.setTags(id, parsed.data.tags);
    repos.audit.add('media', 'metadata.updated', id, parsed.data);
    return { media: galleryItem(app, repos.media.get(id)!) };
  });

  server.post('/api/admin/media/:id/trash', adminGuard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const references = repos.media.references(id);
    const avatar = services.storage.isAvatarMedia(id);
    if (references.total > 0 || avatar) {
      reply.code(409);
      return { error: 'media_in_use', references, avatar };
    }
    if (!repos.media.trash(id)) {
      reply.code(404);
      return { error: 'not_found' };
    }
    repos.audit.add('media', 'trashed', id);
    return { trashed: true };
  });

  server.post('/api/admin/media/:id/restore', adminGuard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!repos.media.restore(id)) {
      reply.code(404);
      return { error: 'not_found' };
    }
    repos.audit.add('media', 'restored', id);
    return { restored: true };
  });

  server.delete('/api/admin/media/:id/permanent', adminGuard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = repos.media.get(id);
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const references = repos.media.references(id);
    const avatar = services.storage.isAvatarMedia(id);
    if (references.total > 0 || avatar) {
      reply.code(409);
      return { error: 'media_is_referenced', references, avatar };
    }
    try {
      const deleted = await services.mediaStore.delete(id);
      if (!deleted) throw new Error('media deletion did not complete');
      repos.audit.add('media', 'permanently.deleted', id, { bytes: row.bytes });
      return { deleted: true };
    } catch (error) {
      repos.errors.add('media.delete', (error as Error).message, { mediaId: id });
      repos.audit.add('media', 'permanent.delete_failed', id, { bytes: row.bytes });
      reply.code(500);
      return { error: 'media_delete_failed', deleted: false, message: '媒体文件删除失败，数据库记录已保留，请稍后重试' };
    }
  });

  server.post('/api/admin/media/batch', adminGuard, async (req, reply) => {
    const parsed = z.object({
      ids: z.array(z.string().regex(IdSchema)).min(1).max(200),
      action: z.enum(['trash', 'restore', 'favorite', 'unfavorite', 'permanent'])
    }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const result = {
      changed: 0,
      blocked: [] as Array<{ id: string; reason: string }>,
      missing: [] as string[],
      failed: [] as Array<{ id: string; reason: string }>
    };
    for (const id of [...new Set(parsed.data.ids)]) {
      const row = repos.media.get(id);
      if (!row) { result.missing.push(id); continue; }
      if (parsed.data.action === 'trash') {
        const refs = repos.media.references(id);
        const avatar = services.storage.isAvatarMedia(id);
        if (refs.total > 0 || avatar) { result.blocked.push({ id, reason: 'referenced' }); continue; }
        result.changed += repos.media.trash(id) ? 1 : 0;
      } else if (parsed.data.action === 'restore') result.changed += repos.media.restore(id) ? 1 : 0;
      else if (parsed.data.action === 'favorite') result.changed += repos.media.setFavorite(id, true) ? 1 : 0;
      else if (parsed.data.action === 'unfavorite') result.changed += repos.media.setFavorite(id, false) ? 1 : 0;
      else {
        const refs = repos.media.references(id);
        if (refs.total > 0 || services.storage.isAvatarMedia(id)) { result.blocked.push({ id, reason: 'referenced' }); continue; }
        try { result.changed += await services.mediaStore.delete(id) ? 1 : 0; }
        catch (error) { repos.errors.add('media.delete', (error as Error).message, { mediaId: id, batch: true }); result.failed.push({ id, reason: 'delete_failed' }); }
      }
    }
    repos.audit.add('media', `batch.${parsed.data.action}`, null, result as unknown as Record<string, unknown>);
    return result;
  });

  server.get('/api/admin/voice', adminGuard, async () => {
    const status = (await services.capabilities.statuses()).tts;
    return {
      capability: status,
      policy: config.getPersona().voicePolicy,
      model: config.safeModels().tts,
      emotions: repos.settings.get('voice.emotions', DEFAULT_VOICE_EMOTIONS),
      supported: { voice: true, speed: true, instructions: true, pitch: false, volume: false }
    };
  });

  server.put('/api/admin/voice', adminGuard, async (req, reply) => {
    const parsed = z.object({
      policy: z.object({
        enabled: z.boolean().optional(),
        frequency: z.enum(['never', 'low', 'medium', 'high']).optional(),
        maxCharsPerClip: z.number().int().min(20).max(2000).optional(),
        alwaysAttachTranscript: z.boolean().optional()
      }).optional(),
      model: z.object({ voice: z.string().min(1).max(80).optional(), speed: z.number().min(0.25).max(4).optional(), expressive: z.boolean().optional(), instructionMode: z.enum(['on', 'auto', 'off']).optional(), emotionIntensity: z.number().min(0).max(1).optional() }).optional(),
      emotions: z.record(z.object({ label: z.string().max(40), instructions: z.string().max(500), speed: z.number().min(0.25).max(4) })).optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    if (parsed.data.policy) {
      const persona = config.getPersona();
      config.setPersona({ voicePolicy: { ...persona.voicePolicy, ...parsed.data.policy } });
    }
    if (parsed.data.model) {
      const current = config.getModels().tts;
      config.setModels({ tts: { ...current, ...parsed.data.model } });
      services.capabilities.rebuild();
    }
    if (parsed.data.emotions) repos.settings.set('voice.emotions', parsed.data.emotions);
    repos.audit.add('voice', 'settings.updated');
    return { policy: config.getPersona().voicePolicy, model: config.safeModels().tts, emotions: repos.settings.get('voice.emotions', DEFAULT_VOICE_EMOTIONS) };
  });

  server.post('/api/admin/voice/preview', adminGuard, async (req, reply) => {
    const parsed = z.object({ text: z.string().min(1).max(1000), emotion: z.string().max(40).default('neutral') }).safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const tts = services.capabilities.ttsProvider();
    if (!tts.configured) { reply.code(503); return { error: 'tts_not_configured', message: '请先配置可用的语音合成模型' }; }
    let options: Record<string, unknown> | undefined;
    let previewText = parsed.data.text;
    if (tts.name === 'fish') {
      const spec = fishCueForMood(parsed.data.emotion, { intensity: 1, moodAlias: parsed.data.emotion, fallbackSpeed: config.getModels().tts.speed });
      previewText = spec.cue ? `${spec.cue} ${parsed.data.text}` : parsed.data.text;
      options = { speed: spec.speed };
    } else {
      const emotions = repos.settings.get<VoiceEmotionMap>('voice.emotions', DEFAULT_VOICE_EMOTIONS);
      options = resolveVoiceDelivery(parsed.data.text, parsed.data.emotion, emotions);
    }
    try {
      const audio = await tts.synthesize(previewText, options);
      void reply.header('content-type', audio.mime).header('cache-control', 'no-store').header('content-disposition', `inline; filename="preview.${audio.format}"`);
      return reply.send(audio.data);
    } catch (err) {
      repos.errors.add('tts.preview', (err as Error).message);
      reply.code(502);
      return { error: 'preview_failed', message: (err as Error).message.slice(0, 300) };
    }
  });
}
