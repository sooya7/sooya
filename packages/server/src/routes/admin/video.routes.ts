import { z } from 'zod';
import type { SooyaApp } from '../../app.js';
import { requireAdminToken } from '../auth.js';
import { VideoRequestError } from '../../core/video/service.js';
import { MediaValidationError } from '../../media/store.js';
import { HttpSizeError, HttpTimeoutError, safeFetch, SsrfError } from '../../util/http.js';

const IdSchema = /^[A-Za-z0-9_-]{1,80}$/u;
const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;

/**
 * Per-request overrides. Everything is optional; the saved video model config
 * supplies defaults. Kept deliberately narrow so a typo cannot smuggle an
 * arbitrary field to the vendor.
 */
const GenerationBodySchema = z.object({
  prompt: z.string().min(1).max(2000),
  /** Image-to-video: an existing media id (upload it first via POST /api/admin/media). */
  imageMediaId: z.string().regex(IdSchema).optional(),
  /** Image-to-video: fetch the first frame from a public URL. */
  imageUrl: z.string().url().max(2000).optional(),
  durationSec: z.coerce.number().int().min(1).max(60).optional(),
  size: z.string().max(20).optional(),
  /** Orientation, e.g. 9:16; resolution still comes from the saved size. */
  aspectRatio: z.string().max(12).optional()
});
type GenerationBody = z.infer<typeof GenerationBodySchema>;

/**
 * 文生视频 / 图生视频 admin API. Generation is asynchronous: POST returns 202
 * with a task, GET polls it, and the finished file is served by /api/media/:id.
 */
export function registerVideoAdminRoutes(app: SooyaApp): void {
  const { server, repos, services, config, env } = app;
  const guard = { preHandler: requireAdminToken(app) };
  const video = services.video;

  server.get('/api/admin/video', guard, async () => ({
    capability: (await services.capabilities.statuses()).video,
    model: config.safeModels().video,
    policy: config.getPersona().videoPolicy,
    active: repos.videoTasks.countActive(),
    total: repos.videoTasks.count()
  }));

  server.put('/api/admin/video', guard, async (req, reply) => {
    const parsed = z.object({
      model: z.record(z.unknown()).optional(),
      /** How she may use [[video]] in chat; mirrors VideoPolicySchema. */
      policy: z.object({
        enabled: z.boolean().optional(),
        frequency: z.enum(['never', 'low', 'medium', 'high']).optional(),
        maxPerDay: z.number().int().min(0).max(50).optional()
      }).optional()
    }).refine((body) => body.model || body.policy, { message: 'model or policy is required' }).safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    try {
      if (parsed.data.model) {
        config.setModels({ video: parsed.data.model });
        services.capabilities.rebuild();
        repos.audit.add('video', 'model.updated');
      }
      if (parsed.data.policy) {
        const persona = config.getPersona();
        config.setPersona({ videoPolicy: { ...persona.videoPolicy, ...parsed.data.policy } });
        repos.audit.add('video', 'policy.updated', null, parsed.data.policy);
      }
    } catch (err) {
      reply.code(400);
      return { error: 'bad_request', message: (err as Error).message.slice(0, 300) };
    }
    return { model: config.safeModels().video, policy: config.getPersona().videoPolicy, capability: (await services.capabilities.statuses()).video };
  });

  server.post('/api/admin/video/generations', guard, async (req, reply) => {
    let body: GenerationBody;
    let uploaded: { data: Buffer; mime: string; filename?: string } | null = null;
    if (req.isMultipart()) {
      const fields: Record<string, string> = {};
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'image' || uploaded) { part.file.resume(); continue; }
            uploaded = { data: await part.toBuffer(), mime: part.mimetype, filename: part.filename };
          } else if (typeof part.value === 'string' && part.value !== '') {
            fields[part.fieldname] = part.value;
          }
        }
      } catch (err) {
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') { reply.code(413); return { error: 'file_too_large', limit: env.MAX_UPLOAD_BYTES }; }
        throw err;
      }
      const parsed = GenerationBodySchema.safeParse(fields);
      if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
      body = parsed.data;
    } else {
      const parsed = GenerationBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
      body = parsed.data;
    }
    if (!video.configured()) {
      reply.code(503);
      return { error: 'video_not_configured', message: '视频生成模型还没配置好（接口协议、地址、模型名、密钥缺一不可）' };
    }
    if ([uploaded, body.imageMediaId, body.imageUrl].filter(Boolean).length > 1) {
      reply.code(400);
      return { error: 'bad_request', message: '参考图只能通过一种方式提供：上传文件、imageMediaId 或 imageUrl' };
    }

    let sourceMediaId = body.imageMediaId ?? null;
    if (!sourceMediaId && (uploaded || body.imageUrl)) {
      let data: Buffer;
      let mime: string | undefined;
      let origin: 'upload' | 'remote' = 'upload';
      let filename: string | undefined;
      if (uploaded) {
        data = uploaded.data;
        mime = uploaded.mime;
        filename = uploaded.filename?.replace(/[\\/\0]/g, '_').slice(0, 120);
      } else {
        origin = 'remote';
        try {
          const fetched = await safeFetch(body.imageUrl!, {
            timeoutMs: env.REMOTE_FETCH_TIMEOUT_MS,
            maxBytes: env.MAX_REMOTE_FETCH_BYTES,
            allowPrivateNetwork: env.ALLOW_PRIVATE_NETWORK_FETCH
          });
          if (!fetched.response.ok) { reply.code(400); return { error: 'image_fetch_failed', message: `参考图下载失败：HTTP ${fetched.response.status}` }; }
          data = fetched.body;
          mime = fetched.response.headers.get('content-type') ?? undefined;
        } catch (err) {
          reply.code(400);
          if (err instanceof SsrfError) return { error: 'unsafe_url', message: `参考图地址不允许访问：${err.message.slice(0, 200)}` };
          if (err instanceof HttpSizeError) return { error: 'image_too_large', message: '参考图超过了允许的大小' };
          if (err instanceof HttpTimeoutError) return { error: 'image_fetch_timeout', message: '参考图下载超时' };
          return { error: 'image_fetch_failed', message: `参考图下载失败：${(err as Error).message.slice(0, 200)}` };
        }
      }
      try {
        await services.storage.assertWritable(data.byteLength);
        const row = await services.mediaStore.save({ kind: 'image', origin, data, declaredMime: mime, filename, meta: { videoSource: true } });
        repos.audit.add('media', 'video.source_imported', row.id, { origin });
        sourceMediaId = row.id;
      } catch (err) {
        const error = err as MediaValidationError & { code?: string };
        reply.code(error.code === 'STORAGE_HARD_LIMIT' ? 507 : error instanceof MediaValidationError ? 415 : 500);
        return { error: 'source_image_rejected', code: error.code ?? 'SAVE_FAILED', message: `参考图无法保存：${error.message.slice(0, 200)}` };
      }
    }

    try {
      const task = await video.create({
        prompt: body.prompt,
        sourceMediaId,
        durationSec: body.durationSec,
        size: body.size,
        aspectRatio: body.aspectRatio,
        origin: { kind: 'admin' }
      });
      reply.code(202);
      return { task };
    } catch (err) {
      if (err instanceof VideoRequestError) {
        reply.code(err.httpStatus);
        return { error: err.code, message: err.publicMessage };
      }
      throw err;
    }
  });

  server.get('/api/admin/video/generations', guard, async (req, reply) => {
    const parsed = z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      status: z.enum(TASK_STATUSES).optional()
    }).safeParse(req.query ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    return video.list(parsed.data);
  });

  server.get('/api/admin/video/generations/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = IdSchema.test(id) ? video.get(id) : null;
    if (!task) { reply.code(404); return { error: 'not_found' }; }
    return { task };
  });

  server.post('/api/admin/video/generations/:id/cancel', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const task = IdSchema.test(id) ? await video.cancel(id) : null;
    if (!task) { reply.code(404); return { error: 'not_found' }; }
    return { task };
  });

  server.delete('/api/admin/video/generations/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = IdSchema.test(id) ? video.get(id) : null;
    if (!existing) { reply.code(404); return { error: 'not_found' }; }
    if (!video.delete(id)) { reply.code(409); return { error: 'task_active', message: '任务还在进行中，先取消再删除' }; }
    repos.audit.add('video', 'task.deleted', id);
    return { deleted: true };
  });
}
