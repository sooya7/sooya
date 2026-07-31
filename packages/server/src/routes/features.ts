import { z } from 'zod';
import type { SooyaApp } from '../app.js';
import { requireAdminToken, requireChatToken } from './auth.js';
import { mediaMeta, toMediaRef, type MediaRow } from '../db/repos/media.repo.js';
import type { BrowserPushSubscription } from '../core/push.js';
import { DEFAULT_VOICE_EMOTIONS, resolveVoiceDelivery, type VoiceEmotionMap } from '../core/voice.js';
import { LifePolicySchema } from '../config/schema.js';

const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const WorldCandidateSchema = z.object({
  kind: z.enum(['entity', 'relation', 'fact', 'scene', 'timeline']),
  subject: z.string().min(1).max(200),
  predicate: z.string().min(1).max(120),
  object: z.string().min(1).max(500),
  value: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  authority: z.enum(['model', 'user', 'admin']).optional()
});

export function registerFeatureRoutes(app: SooyaApp): void {
  const { server, repos, services, config } = app;
  const admin = requireAdminToken(app);
  const chat = requireChatToken(app);
  const adminGuard = { preHandler: admin };
  const chatGuard = { preHandler: chat };

  /* -------------------------------- avatars -------------------------------- */
  server.post('/api/admin/persona/avatar/:slot', adminGuard, async (req, reply) => {
    const slot = (req.params as { slot: string }).slot;
    if (slot !== 'assistant' && slot !== 'user') {
      reply.code(400);
      return { error: 'bad_slot' };
    }
    if (!req.isMultipart()) {
      reply.code(400);
      return { error: 'expected_multipart' };
    }
    let saved: MediaRow | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const buffer = await part.toBuffer();
        await services.storage.assertWritable(buffer.length);
        saved = await services.mediaStore.save({
          kind: 'image',
          origin: 'upload',
          data: buffer,
          declaredMime: part.mimetype,
          filename: sanitizeName(part.filename ?? `${slot}-avatar`),
          meta: { avatar: slot }
        });
        break;
      }
      if (!saved) {
        reply.code(400);
        return { error: 'missing_file' };
      }
      const before = config.getPersona();
      const oldUrl = slot === 'assistant' ? before.avatar : before.userAvatar;
      const url = `/api/media/${saved.id}?v=${saved.sha256.slice(0, 12)}`;
      const persona = config.setPersona(slot === 'assistant' ? { avatar: url } : { userAvatar: url });
      const oldId = mediaIdFromUrl(oldUrl);
      if (oldId && oldId !== saved.id && repos.media.references(oldId).total === 0 && !services.storage.isAvatarMedia(oldId)) repos.media.trash(oldId);
      repos.audit.add('persona', 'avatar.updated', saved.id, { slot, oldId });
      services.bus.publish('persona.updated', { persona: { name: persona.name, avatar: persona.avatar, userAvatar: persona.userAvatar, tagline: persona.tagline } });
      return { persona, media: galleryItem(app, saved) };
    } catch (err) {
      if (saved) await services.mediaStore.delete(saved.id).catch(() => false);
      const e = err as Error & { code?: string };
      reply.code(e.code === 'STORAGE_HARD_LIMIT' ? 507 : 415);
      return { error: e.code ?? 'avatar_upload_failed', message: e.message.slice(0, 300) };
    }
  });

  /* -------------------------------- push ----------------------------------- */
  /*
   * What she is doing, for the header in the client. Behind the chat guard
   * rather than the admin guard: this is hers to show the user, not a setting.
   */
  server.get('/api/life', chatGuard, async () => services.life.snapshot());

  server.post('/api/admin/life/tick', adminGuard, async () => {
    const result = services.life.tick();
    return { ...result, snapshot: services.life.snapshot() };
  });

  /*
   * Everything needed to answer "what is she doing, and why hasn't she said
   * anything". The reach-out reason is the useful half: without it the only
   * observable is silence, which looks identical whether she is capped, inside
   * quiet hours, or simply has nothing finished worth mentioning.
   */
  server.get('/api/admin/life', adminGuard, async () => {
    const recent = repos.messages.recent(40);
    const lastUser = [...recent].reverse().find((msg) => msg.role === 'user');
    const lastAssistant = [...recent].reverse().find((msg) => msg.role === 'assistant');
    const decision = services.life.shouldReachOut(
      lastUser ? new Date(lastUser.createdAt) : null,
      lastAssistant ? new Date(lastAssistant.createdAt) : null
    );
    const settings = services.life.settings;
    return {
      snapshot: services.life.snapshot(),
      log: repos.life.recent(24),
      reachOut: {
        reach: decision.reach,
        reason: decision.reason,
        candidate: decision.candidate ? { id: decision.candidate.id, activity: decision.candidate.activity, endedAt: decision.candidate.ended_at } : null,
        sharedLastDay: repos.life.countSharedSince(new Date(Date.now() - 86_400_000).toISOString()),
        lastUserAt: lastUser?.createdAt ?? null,
        lastAssistantAt: lastAssistant?.createdAt ?? null,
        // The env var is a kill switch the panel cannot override, so say so.
        enabledByDeployment: app.env.ENABLE_LIFE_ENGINE && app.env.ENABLE_LIFE_REACH_OUT
      },
      settings: {
        reachOut: settings.reachOut,
        quietGapMinutes: settings.quietGapMinutes,
        maxReachOutsPerDay: settings.maxReachOutsPerDay,
        silentFrom: settings.silentHours.from,
        silentTo: settings.silentHours.to,
        tzOffsetMinutes: settings.tzOffsetMinutes
      }
    };
  });

  server.put('/api/admin/life/settings', adminGuard, async (req, reply) => {
    const parsed = LifePolicySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_life_policy', message: parsed.error.message.slice(0, 300) };
    }
    const persona = config.setPersona({ lifePolicy: { ...config.getPersona().lifePolicy, ...parsed.data } });
    repos.audit.add('life', 'settings', null, parsed.data as Record<string, unknown>);
    services.bus.publish('life.updated', { settings: true });
    const settings = services.life.settings;
    return {
      lifePolicy: persona.lifePolicy,
      settings: {
        reachOut: settings.reachOut,
        quietGapMinutes: settings.quietGapMinutes,
        maxReachOutsPerDay: settings.maxReachOutsPerDay,
        silentFrom: settings.silentHours.from,
        silentTo: settings.silentHours.to,
        tzOffsetMinutes: settings.tzOffsetMinutes
      }
    };
  });

  server.get('/api/push/public-key', chatGuard, async () => ({ publicKey: services.push.publicKey(), status: services.push.status() }));
  server.get('/api/push/status', chatGuard, async () => services.push.status());
  server.post('/api/push/subscribe', chatGuard, async (req, reply) => {
    const parsed = z.object({
      endpoint: z.string().url().max(2048),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({ p256dh: z.string().min(8).max(512), auth: z.string().min(4).max(256) })
    }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_subscription', issues: parsed.error.issues };
    }
    services.push.subscribe(parsed.data as BrowserPushSubscription);
    repos.audit.add('push', 'subscribed', new URL(parsed.data.endpoint).origin);
    return { subscribed: true, status: services.push.status() };
  });
  server.post('/api/push/unsubscribe', chatGuard, async (req, reply) => {
    const parsed = z.object({ endpoint: z.string().url().max(2048) }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request' };
    }
    return { unsubscribed: services.push.unsubscribe(parsed.data.endpoint), status: services.push.status() };
  });
  server.post('/api/push/visibility', chatGuard, async (req, reply) => {
    const parsed = z.object({ endpoint: z.string().url().max(2048), visible: z.boolean() }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request' };
    }
    services.push.setVisibility(parsed.data.endpoint, parsed.data.visible);
    return { ok: true };
  });

  /* -------------------------------- gallery -------------------------------- */
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
      to: q.to
    };
    const rows = repos.media.listGallery(query);
    return { media: rows.map((row) => galleryItem(app, row)), stats: repos.media.galleryStats(query), total: repos.media.count() };
  });

  server.patch('/api/admin/media/:id', adminGuard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!IdSchema.safeParse(id).success || !repos.media.get(id)) {
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
      ids: z.array(IdSchema).min(1).max(200),
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
      if (parsed.data.action === 'trash') result.changed += repos.media.trash(id) ? 1 : 0;
      else if (parsed.data.action === 'restore') result.changed += repos.media.restore(id) ? 1 : 0;
      else if (parsed.data.action === 'favorite') result.changed += repos.media.setFavorite(id, true) ? 1 : 0;
      else if (parsed.data.action === 'unfavorite') result.changed += repos.media.setFavorite(id, false) ? 1 : 0;
      else {
        const refs = repos.media.references(id);
        if (refs.total > 0 || services.storage.isAvatarMedia(id)) {
          result.blocked.push({ id, reason: 'referenced' });
          continue;
        }
        try {
          result.changed += await services.mediaStore.delete(id) ? 1 : 0;
        } catch (error) {
          repos.errors.add('media.delete', (error as Error).message, { mediaId: id, batch: true });
          result.failed.push({ id, reason: 'delete_failed' });
        }
      }
    }
    repos.audit.add('media', `batch.${parsed.data.action}`, null, result as unknown as Record<string, unknown>);
    return result;
  });

  /* -------------------------------- voice ---------------------------------- */
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
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
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
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const tts = services.capabilities.ttsProvider();
    if (!tts.configured) {
      reply.code(503);
      return { error: 'tts_not_configured', message: '请先配置可用的语音合成模型' };
    }
    const emotions = repos.settings.get<VoiceEmotionMap>('voice.emotions', DEFAULT_VOICE_EMOTIONS);
    const delivery = resolveVoiceDelivery(parsed.data.text, parsed.data.emotion, emotions);
    try {
      const audio = await tts.synthesize(parsed.data.text, delivery);
      void reply.header('content-type', audio.mime).header('cache-control', 'no-store').header('content-disposition', `inline; filename="preview.${audio.format}"`);
      return reply.send(audio.data);
    } catch (err) {
      repos.errors.add('tts.preview', (err as Error).message);
      reply.code(502);
      return { error: 'preview_failed', message: (err as Error).message.slice(0, 300) };
    }
  });

  /* -------------------------------- world ---------------------------------- */
  server.get('/api/admin/world', adminGuard, async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const kind = ['entity', 'relation', 'fact', 'scene', 'timeline'].includes(q.kind ?? '') ? q.kind as never : undefined;
    const active = q.active === undefined ? undefined : q.active !== 'false' && q.active !== '0';
    return { entries: repos.world.list({ search: q.search, kind, active, limit: Number(q.limit ?? 100), offset: Number(q.offset ?? 0) }), total: repos.world.count() };
  });
  server.post('/api/admin/world', adminGuard, async (req, reply) => {
    const parsed = WorldCandidateSchema.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const entry = repos.world.create({ ...parsed.data, authority: 'admin' });
    repos.audit.add('world', 'created', entry.id);
    services.bus.publish('world.updated', { id: entry.id, action: 'created' });
    return { entry };
  });
  server.patch('/api/admin/world/:id', adminGuard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = WorldCandidateSchema.partial().extend({ active: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    const entry = repos.world.update(id, { ...parsed.data, authority: parsed.data.authority ?? 'admin' });
    if (!entry) { reply.code(404); return { error: 'not_found' }; }
    repos.audit.add('world', 'updated', id);
    services.bus.publish('world.updated', { id, action: 'updated' });
    return { entry };
  });
  server.delete('/api/admin/world/:id', adminGuard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const deleted = repos.world.remove(id);
    if (!deleted) { reply.code(404); return { error: 'not_found' }; }
    repos.audit.add('world', 'deleted', id);
    services.bus.publish('world.updated', { id, action: 'deleted' });
    return { deleted: true };
  });
  server.get('/api/admin/world/export', adminGuard, async () => services.world.export());
  server.post('/api/admin/world/import', adminGuard, async (req, reply) => {
    try {
      const result = services.world.import(req.body);
      repos.audit.add('world', 'imported', null, result);
      services.bus.publish('world.updated', { imported: true, ...result });
      return result;
    } catch (err) {
      reply.code(400);
      return { error: 'invalid_import', message: (err as Error).message };
    }
  });
  server.post('/api/admin/world/rebuild', adminGuard, async (req) => {
    const limit = Number((req.body as { limit?: number } | undefined)?.limit ?? 400);
    const job = repos.jobs.enqueue('world.rebuild', { limit }, { maxAttempts: 2 });
    return { queued: true, job };
  });

  /* -------------------------------- storage -------------------------------- */
  server.get('/api/admin/storage', adminGuard, async () => await services.storage.status());
  server.put('/api/admin/storage/policy', adminGuard, async (req, reply) => {
    const parsed = z.object({
      softLimitBytes: z.number().int().positive().optional(),
      hardLimitBytes: z.number().int().positive().optional(),
      trashRetentionDays: z.number().int().positive().optional(),
      tempRetentionHours: z.number().int().positive().optional(),
      backupKeep: z.number().int().positive().optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'bad_request', issues: parsed.error.issues }; }
    return { policy: services.storage.setPolicy(parsed.data) };
  });
  server.post('/api/admin/storage/cleanup', adminGuard, async (req, reply) => {
    const parsed = z.object({
      apply: z.boolean().default(false),
      categories: z.array(z.string()).max(10).optional(),
      reportId: z.string().regex(/^cleanup_[A-Za-z0-9_-]{10,80}$/).optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: 'bad_request' }; }
    if (parsed.data.apply && !parsed.data.reportId) {
      reply.code(409);
      return { error: 'cleanup_report_required', message: '请先生成并确认清理预览' };
    }
    try {
      return await services.storage.cleanup(parsed.data);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === 'CLEANUP_REPORT_REQUIRED' || code === 'CLEANUP_REPORT_INVALID') {
        reply.code(409);
        return { error: 'cleanup_report_invalid', message: '清理预览不存在或已过期，请重新预览' };
      }
      throw error;
    }
  });
  server.get('/api/admin/audit', adminGuard, async (req) => ({ audit: repos.audit.list(Number((req.query as { limit?: string }).limit ?? 100)) }));
}

function galleryItem(app: SooyaApp, row: MediaRow) {
  const parsed = mediaMeta(row);
  return {
    ...toMediaRef(row),
    origin: row.origin,
    exists: app.services.mediaStore.exists(row),
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    favorite: row.favorite === 1,
    tags: parsed.tags,
    meta: parsed.meta,
    references: app.repos.media.references(row.id)
  };
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/\0]/g, '_').slice(0, 120);
}

function mediaIdFromUrl(url: string): string | null {
  return /\/api\/media\/([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null;
}
