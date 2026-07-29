import fsp from 'node:fs/promises';
import os from 'node:os';
import { z } from 'zod';
import type { SooyaApp } from '../app.js';
import { requireAdminToken } from './auth.js';
import { PersonaSchema } from '../config/schema.js';
import { mediaMeta, toMediaRef } from '../db/repos/media.repo.js';

/** Admin API used by the built-in management panel. */
export function registerAdminRoutes(app: SooyaApp): void {
  const { server, repos, services, config } = app;
  const admin = requireAdminToken(app);
  const guard = { preHandler: admin };

  server.get('/api/admin/persona', guard, async () => ({ persona: config.getPersona() }));
  server.put('/api/admin/persona', guard, async (req, reply) => {
    const parsed = PersonaSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    try {
      const persona = config.setPersona(parsed.data);
      services.bus.publish('persona.updated', { persona: { name: persona.name, avatar: persona.avatar, userAvatar: persona.userAvatar, tagline: persona.tagline } });
      return { persona };
    } catch (err) {
      reply.code(400);
      return { error: 'invalid_persona', message: (err as Error).message };
    }
  });

  server.get('/api/admin/models', guard, async () => ({ models: config.safeModels() }));
  server.put('/api/admin/models', guard, async (req, reply) => {
    try {
      config.setModels(req.body);
      services.capabilities.rebuild();
      return { models: config.safeModels() };
    } catch (err) {
      reply.code(400);
      return { error: 'invalid_models', message: (err as Error).message.slice(0, 500) };
    }
  });

  server.get('/api/admin/capabilities', guard, async () => ({
    capabilities: await services.capabilities.statuses(),
    embeddingDimensions: services.capabilities.embeddingDimensions()
  }));

  server.put('/api/admin/tts', guard, async (req, reply) => {
    const schema = z.object({
      model: z.record(z.unknown()).optional(),
      policy: z.object({
        enabled: z.boolean().optional(),
        frequency: z.enum(['never', 'low', 'medium', 'high']).optional(),
        maxCharsPerClip: z.number().int().min(20).max(2000).optional(),
        alwaysAttachTranscript: z.boolean().optional()
      }).optional()
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    if (parsed.data.model) {
      config.setModels({ tts: parsed.data.model });
      services.capabilities.rebuild();
    }
    if (parsed.data.policy) {
      const persona = config.getPersona();
      config.setPersona({ voicePolicy: { ...persona.voicePolicy, ...parsed.data.policy } });
    }
    return { models: config.safeModels(), voicePolicy: config.getPersona().voicePolicy };
  });

  server.put('/api/admin/image', guard, async (req, reply) => {
    const schema = z.object({
      model: z.record(z.unknown()).optional(),
      policy: z.object({
        enabled: z.boolean().optional(),
        frequency: z.enum(['never', 'low', 'medium', 'high']).optional(),
        maxPerReply: z.number().int().min(0).max(4).optional()
      }).optional()
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    if (parsed.data.model) {
      config.setModels({ image: parsed.data.model });
      services.capabilities.rebuild();
    }
    if (parsed.data.policy) {
      const persona = config.getPersona();
      config.setPersona({ imagePolicy: { ...persona.imagePolicy, ...parsed.data.policy } });
    }
    return { models: config.safeModels(), imagePolicy: config.getPersona().imagePolicy };
  });

  server.get('/api/admin/stickers', guard, async () => ({ stickers: services.stickerLibrary.all() }));
  server.post('/api/admin/stickers', guard, async (req, reply) => {
    if (!req.isMultipart()) {
      reply.code(400);
      return { error: 'expected_multipart' };
    }
    const created: unknown[] = [];
    const failed: Array<{ filename: string; error: string }> = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const fields = part.fields as Record<string, { value?: string } | undefined>;
      const name = (fields.name?.value ?? part.filename ?? 'sticker').replace(/\.[^.]+$/, '').slice(0, 60);
      const emotion = fields.emotion?.value ?? 'neutral';
      const tags = (fields.tags?.value ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
      try {
        const buffer = await part.toBuffer();
        await services.storage.assertWritable(buffer.length);
        const media = await services.mediaStore.save({ kind: 'sticker', origin: 'upload', data: buffer, declaredMime: part.mimetype, filename: part.filename });
        const unique = repos.stickers.getByName(name) ? `${name}-${Date.now().toString(36)}` : name;
        created.push(repos.stickers.create({ mediaId: media.id, name: unique, tags: tags.length ? tags : [emotion], emotion }));
      } catch (err) {
        failed.push({ filename: part.filename ?? 'unknown', error: (err as Error).message });
      }
    }
    if (created.length === 0) {
      reply.code(400);
      return { created, failed };
    }
    return { created, failed };
  });

  server.patch('/api/admin/stickers/:id', guard, async (req, reply) => {
    const parsed = z.object({ tags: z.array(z.string()).optional(), emotion: z.string().optional(), enabled: z.boolean().optional(), name: z.string().min(1).max(60).optional() }).safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'bad_request', issues: parsed.error.issues };
    }
    const updated = repos.stickers.update((req.params as { id: string }).id, parsed.data);
    if (!updated) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { sticker: updated };
  });

  server.delete('/api/admin/stickers/:id', guard, async (req, reply) => {
    const sticker = repos.stickers.get((req.params as { id: string }).id);
    if (!sticker) {
      reply.code(404);
      return { error: 'not_found' };
    }
    repos.stickers.delete(sticker.id);
    await services.mediaStore.delete(sticker.mediaId);
    repos.audit.add('sticker', 'deleted', sticker.id);
    return { deleted: true };
  });

  server.get('/api/admin/memories', guard, async (req) => {
    const q = req.query as { limit?: string; offset?: string; kind?: string };
    return { memories: repos.memories.list({ limit: Number(q.limit ?? 100), offset: Number(q.offset ?? 0), kind: q.kind as never }), stats: services.memory.stats() };
  });
  server.delete('/api/admin/memories/:id', guard, async (req, reply) => {
    const ok = repos.memories.delete((req.params as { id: string }).id);
    if (!ok) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { deleted: true };
  });
  server.post('/api/admin/memories/clear', guard, async () => {
    const result = services.memory.clearAll();
    services.bus.publish('memory.updated', { cleared: true, ...result });
    return { cleared: true, ...result, stats: services.memory.stats() };
  });

  server.get('/api/admin/media', guard, async (req) => {
    const q = req.query as { limit?: string; offset?: string; kind?: string };
    const rows = repos.media.list(Number(q.limit ?? 50), Number(q.offset ?? 0), q.kind as never);
    return {
      media: rows.map((row) => ({
        ...toMediaRef(row),
        origin: row.origin,
        exists: services.mediaStore.exists(row),
        createdAt: row.created_at,
        deletedAt: row.deleted_at,
        favorite: row.favorite === 1,
        ...mediaMeta(row)
      })),
      total: repos.media.count()
    };
  });

  /** Legacy endpoint now performs a reversible soft delete. */
  server.delete('/api/admin/media/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!repos.media.trash(id)) {
      reply.code(404);
      return { error: 'not_found' };
    }
    repos.audit.add('media', 'trashed.legacy', id);
    return { deleted: true, trashed: true };
  });

  server.get('/api/admin/system', guard, async () => ({
    version: app.state.version,
    startedAt: app.state.startedAt,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    loadAvg: os.loadavg(),
    database: {
      recovered: app.state.dbRecovered,
      recoveredFrom: app.state.dbRecoveredFrom ?? null,
      messages: repos.messages.count(),
      media: repos.media.count(),
      memories: repos.memories.count(),
      summaries: repos.summaries.count(),
      world: repos.world.count(),
      pushSubscriptions: repos.pushSubscriptions.count(),
      pendingJobs: repos.jobs.pendingCount()
    },
    storage: await services.storage.status(),
    stream: { subscribers: services.bus.subscriberCount(), lastEventSeq: services.bus.lastSeq() },
    agent: { active: services.agents.active, tools: services.tools.list(), capabilities: services.agentCapabilities.list() }
  }));

  server.get('/api/admin/errors', guard, async (req) => ({ errors: repos.errors.list(Number((req.query as { limit?: string }).limit ?? 100)) }));
  server.delete('/api/admin/errors', guard, async () => { repos.errors.clear(); return { cleared: true }; });
  server.get('/api/admin/jobs', guard, async () => ({ jobs: repos.jobs.list(50) }));

  server.post('/api/admin/chat/clear', guard, async () => {
    repos.messages.clearAll();
    repos.events.clear();
    services.bus.publish('system.notice', { notice: 'chat cleared', reason: 'chat-cleared', action: 'reload', lastMessageSeq: 0 });
    return { cleared: true, messages: repos.messages.count() };
  });

  server.get('/api/admin/backups', guard, async () => ({ backups: await services.backups.list() }));
  server.post('/api/admin/backups', guard, async (_req, reply) => {
    try { return { backup: await services.backups.create('manual') }; }
    catch (err) { reply.code(500); return { error: 'backup_failed', message: (err as Error).message }; }
  });
  server.post('/api/admin/backups/:name/verify', guard, async (req) => await services.backups.verify((req.params as { name: string }).name));
  server.post('/api/admin/backups/:name/restore', guard, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    try {
      const result = await services.backups.restore(name);
      services.bus.publish('system.notice', { notice: 'database restored from backup', backup: name, reason: 'database-restored', action: 'reload', lastMessageSeq: repos.messages.maxSeq() });
      return { restored: true, backupPath: result.restored, preservedAs: result.preservedAs };
    } catch (err) {
      reply.code(400);
      return { error: 'restore_failed', message: (err as Error).message };
    }
  });
  server.delete('/api/admin/backups/:name', guard, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!/^sooya-[\w.-]+\.db$/.test(name)) {
      reply.code(400);
      return { error: 'bad_name' };
    }
    const found = (await services.backups.list()).find((backup) => backup.name === name);
    if (!found) {
      reply.code(404);
      return { error: 'not_found' };
    }
    await fsp.rm(found.path, { force: true });
    await fsp.rm(`${found.path}.json`, { force: true });
    await fsp.rm(`${found.path}.sha256`, { force: true });
    repos.audit.add('backup', 'deleted', name);
    return { deleted: true };
  });
}
