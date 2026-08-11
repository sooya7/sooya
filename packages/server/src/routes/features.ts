import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import type { SooyaApp } from '../app.js';
import { resolveReferencesDir } from '../app.js';
import { requireAdminToken, requireChatToken } from './auth.js';
import { mediaMeta, toMediaRef, type MediaRow } from '../db/repos/media.repo.js';
import type { BrowserPushSubscription } from '../core/push.js';
import { DEFAULT_VOICE_EMOTIONS, resolveVoiceDelivery, type VoiceEmotionMap } from '../core/voice.js';
import { fishCueForMood } from '../core/voice/fishCue.js';
import { LifePolicySchema } from '../config/schema.js';
import { classifyFraming } from '../media/persona-references.js';
import { atomicWriteFile, ensureDirSync, safeJoin } from '../util/fsx.js';

const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
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

  /* --------------------------- persona references --------------------------- */
  /*
   * 参考图不走媒体库：它们是配置的一部分，文件名本身携带视角线索
   * （side/full_body/front），自动选图靠它匹配。所以这里直接管理
   * 磁盘文件 + persona.referenceImages 名单，而不生成 media 行。
   */
  const REF_NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;
  const REF_MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  };
  const refItem = (dir: string | null, name: string, configured: boolean) => {
    let exists = false;
    let bytes = 0;
    if (dir) {
      try {
        const stat = fs.statSync(safeJoin(dir, name));
        exists = stat.isFile();
        bytes = stat.size;
      } catch { /* missing file: surface as exists=false */ }
    }
    return { name, configured, exists, bytes, framing: classifyFraming(name) };
  };

  server.get('/api/admin/persona/references', adminGuard, async () => {
    const dir = resolveReferencesDir(app.env);
    const configured = config.getPersona().referenceImages;
    const seen = new Map<string, ReturnType<typeof refItem>>();
    for (const name of configured) seen.set(name, refItem(dir, name, true));
    if (dir && fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (!REF_MIME_BY_EXT[path.extname(entry).toLowerCase()]) continue;
        if (!seen.has(entry)) seen.set(entry, refItem(dir, entry, false));
      }
    }
    return { dir, references: [...seen.values()] };
  });

  server.post('/api/admin/persona/references', adminGuard, async (req, reply) => {
    const dir = resolveReferencesDir(app.env);
    if (!dir) {
      reply.code(507);
      return { error: 'references_dir_unavailable', message: '参考图目录不可用，请检查 assets/references 或 SOOYA_REFERENCES_DIR。' };
    }
    if (!req.isMultipart()) {
      reply.code(400);
      return { error: 'expected_multipart' };
    }
    let buffer: Buffer | null = null;
    let filename = '';
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        buffer = await part.toBuffer();
        filename = part.filename ?? '';
        break;
      }
      if (!buffer) {
        reply.code(400);
        return { error: 'missing_file' };
      }
      if (buffer.length > app.env.MAX_UPLOAD_BYTES) {
        reply.code(413);
        return { error: 'file_too_large', message: `参考图不能超过 ${Math.round(app.env.MAX_UPLOAD_BYTES / 1024 / 1024)} MB。` };
      }
      await services.storage.assertWritable(buffer.length);
      // 嗅探真实类型：扩展名可以伪装，字节不会。只收图片。
      const sniffed = await fileTypeFromBuffer(buffer);
      if (!sniffed || !REF_MIME_BY_EXT[`.${sniffed.ext}`]) {
        reply.code(415);
        return { error: 'unsupported_image', message: '只支持 PNG / JPG / WEBP / GIF 图片。' };
      }
      // 文件名只留安全字符；扩展名以嗅探结果为准，避免「.png 里装 exe」重演。
      const base = path.basename(filename).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'reference';
      const name = `${base}.${sniffed.ext}`;
      ensureDirSync(dir);
      await atomicWriteFile(safeJoin(dir, name), buffer);
      const current = config.getPersona().referenceImages;
      if (!current.includes(name)) config.setPersona({ referenceImages: [...current, name] });
      repos.audit.add('persona', 'reference.uploaded', name, { bytes: buffer.length, mime: sniffed.mime });
      return { reference: refItem(dir, name, true), referenceImages: config.getPersona().referenceImages };
    } catch (err) {
      const e = err as Error & { code?: string };
      reply.code(e.code === 'STORAGE_HARD_LIMIT' ? 507 : 400);
      return { error: e.code ?? 'reference_upload_failed', message: e.message.slice(0, 300) };
    }
  });

  /*
   * 按视角槽位上传：正面 / 全身 / 侧脸各一格，传进来就自动改成带该视角
   * 线索的规范文件名，并替换同视角的旧图，管理员不用操心文件名。
   */
  const SLOT_NAME_BY_FRAMING: Record<string, string> = { front: 'ref_front', 'full-body': 'ref_full_body', side: 'ref_side' };
  server.post('/api/admin/persona/references/slot/:framing', adminGuard, async (req, reply) => {
    const framing = (req.params as { framing: string }).framing;
    const slotBase = SLOT_NAME_BY_FRAMING[framing];
    if (!slotBase) {
      reply.code(400);
      return { error: 'bad_framing', message: '视角只能是 front、full-body 或 side。' };
    }
    const dir = resolveReferencesDir(app.env);
    if (!dir) {
      reply.code(507);
      return { error: 'references_dir_unavailable', message: '参考图目录不可用，请检查 assets/references 或 SOOYA_REFERENCES_DIR。' };
    }
    if (!req.isMultipart()) {
      reply.code(400);
      return { error: 'expected_multipart' };
    }
    let buffer: Buffer | null = null;
    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        buffer = await part.toBuffer();
        break;
      }
      if (!buffer) {
        reply.code(400);
        return { error: 'missing_file' };
      }
      if (buffer.length > app.env.MAX_UPLOAD_BYTES) {
        reply.code(413);
        return { error: 'file_too_large', message: `参考图不能超过 ${Math.round(app.env.MAX_UPLOAD_BYTES / 1024 / 1024)} MB。` };
      }
      await services.storage.assertWritable(buffer.length);
      const sniffed = await fileTypeFromBuffer(buffer);
      if (!sniffed || !REF_MIME_BY_EXT[`.${sniffed.ext}`]) {
        reply.code(415);
        return { error: 'unsupported_image', message: '只支持 PNG / JPG / WEBP / GIF 图片。' };
      }
      const name = `${slotBase}.${sniffed.ext}`;
      ensureDirSync(dir);
      await atomicWriteFile(safeJoin(dir, name), buffer);
      // 同视角的旧图下岗：文件删掉、名单移除；新图顶进旧位置（没有就追加）。
      const current = config.getPersona().referenceImages;
      const sameFraming = current.filter((n) => classifyFraming(n) === framing);
      const next = current.filter((n) => classifyFraming(n) !== framing);
      for (const old of sameFraming) {
        if (old === name) continue;
        try { fs.unlinkSync(safeJoin(dir, old)); } catch { /* already gone */ }
      }
      const insertAt = sameFraming.length > 0 ? current.indexOf(sameFraming[0]!) : next.length;
      next.splice(Math.min(insertAt, next.length), 0, name);
      config.setPersona({ referenceImages: next });
      repos.audit.add('persona', 'reference.slot_uploaded', name, { framing, replaced: sameFraming.filter((n) => n !== name), bytes: buffer.length, mime: sniffed.mime });
      return { reference: refItem(dir, name, true), replaced: sameFraming.filter((n) => n !== name), referenceImages: next };
    } catch (err) {
      const e = err as Error & { code?: string };
      reply.code(e.code === 'STORAGE_HARD_LIMIT' ? 507 : 400);
      return { error: e.code ?? 'reference_upload_failed', message: e.message.slice(0, 300) };
    }
  });

  server.get('/api/admin/persona/references/:name/data', adminGuard, async (req, reply) => {
    const { name } = req.params as { name: string };
    const dir = resolveReferencesDir(app.env);
    if (!REF_NAME_RE.test(name) || !dir) {
      reply.code(400);
      return { error: 'bad_name' };
    }
    let file: string;
    try {
      file = safeJoin(dir, name);
    } catch {
      reply.code(400);
      return { error: 'bad_name' };
    }
    if (!fs.existsSync(file)) {
      reply.code(404);
      return { error: 'not_found' };
    }
    /*
     * 参考图会被槽位上传同名替换，不能长缓存；但每次都传 2MB 也太浪费。
     * 折中：private, no-cache —— 浏览器可以存，但每次都要拿 ETag/Last-Modified
     * 回来验证，没变就只回 304（几十字节）。private 避免 CDN 边缘存下管理图。
     */
    const stat = fs.statSync(file);
    const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(36)}"`;
    const lastModified = stat.mtime.toUTCString();
    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = req.headers['if-modified-since'];
    if ((typeof ifNoneMatch === 'string' && ifNoneMatch === etag) || (!ifNoneMatch && typeof ifModifiedSince === 'string' && ifModifiedSince === lastModified)) {
      return reply.code(304).header('cache-control', 'private, no-cache').header('etag', etag).header('last-modified', lastModified).send();
    }
    const mime = REF_MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
    return reply.type(mime)
      .header('cache-control', 'private, no-cache')
      .header('etag', etag)
      .header('last-modified', lastModified)
      .send(fs.createReadStream(file));
  });

  server.delete('/api/admin/persona/references/:name', adminGuard, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!REF_NAME_RE.test(name)) {
      reply.code(400);
      return { error: 'bad_name' };
    }
    const current = config.getPersona().referenceImages;
    if (current.includes(name)) config.setPersona({ referenceImages: current.filter((n) => n !== name) });
    const dir = resolveReferencesDir(app.env);
    let removedFile = false;
    if (dir) {
      try {
        fs.unlinkSync(safeJoin(dir, name));
        removedFile = true;
      } catch { /* already gone */ }
    }
    repos.audit.add('persona', 'reference.deleted', name, { removedFile });
    return { deleted: true, removedFile, referenceImages: config.getPersona().referenceImages };
  });

  /* -------------------------------- push ----------------------------------- */
  /*
   * What she is doing, for the header in the client. Behind the chat guard
   * rather than the admin guard: this is hers to show the user, not a setting.
   */
  server.get('/api/life', chatGuard, async () => services.life.snapshot());
  server.get('/api/life/locations', chatGuard, async () => ({ locations: services.location.list(), current: services.location.current() }));
  server.get('/api/life/world', chatGuard, async () => services.world.snapshot());
  server.get('/api/life/presence', chatGuard, async () => services.presence.current());

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
    const evaluation = services.proactive.evaluate();
    const settings = services.life.settings;
    return {
      snapshot: services.life.snapshot(),
      log: repos.life.recent(24),
      plans: repos.life.listPlans().slice(0, 50),
      events: repos.life.events(50),
      proactive: repos.proactive.list(50),
      reachOut: {
        reach: evaluation.reach,
        reason: evaluation.reason,
        candidate: evaluation.candidate ? { id: evaluation.candidate.id, activity: evaluation.candidate.activity, endedAt: evaluation.candidate.ended_at } : null,
        sharedLastDay: repos.life.countSharedSince(new Date(Date.now() - 86_400_000).toISOString()),
        lastUserAt: evaluation.lastUserAt,
        lastAssistantAt: evaluation.lastAssistantAt,
        // The env var is a kill switch the panel cannot override, so say so.
        enabledByDeployment: app.env.ENABLE_LIFE_ENGINE && app.env.ENABLE_LIFE_REACH_OUT
      },
      settings: {
        reachOut: settings.reachOut,
        quietGapMinutes: settings.quietGapMinutes,
        maxReachOutsPerDay: settings.maxReachOutsPerDay,
        silentFrom: settings.silentHours.from,
        silentTo: settings.silentHours.to,
        tzOffsetMinutes: settings.tzOffsetMinutes,
        proactiveMode: settings.proactiveMode ?? 'auto'
      }
    };
  });

  server.post('/api/admin/life/plans', adminGuard, async (req, reply) => {
    const parsed = z.object({
      title: z.string().trim().min(1).max(200),
      kind: z.string().trim().min(1).max(40),
      plannedStart: z.string().trim().max(80).nullable().optional(),
      plannedEnd: z.string().trim().max(80).nullable().optional(),
      status: z.enum(['planned', 'active', 'paused', 'completed', 'cancelled', 'skipped']).optional(),
      source: z.enum(['routine', 'generated', 'admin', 'conversation']).optional(),
      priority: z.number().int().min(-100).max(100).optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_life_plan', message: parsed.error.message.slice(0, 300) };
    }
    const plan = repos.life.createPlan(parsed.data);
    repos.audit.add('life', 'plan.created', plan.id, { title: plan.title, kind: plan.kind, status: plan.status });
    services.bus.publish('life.updated', { plan: plan.id });
    return { plan };
  });

  server.patch('/api/admin/life/plans/:id', adminGuard, async (req, reply) => {
    const id = String((req.params as { id: string }).id);
    if (!IdSchema.safeParse(id).success) {
      reply.code(400);
      return { error: 'bad_plan_id' };
    }
    const parsed = z.object({
      title: z.string().trim().min(1).max(200).optional(),
      kind: z.string().trim().min(1).max(40).optional(),
      plannedStart: z.string().trim().max(80).nullable().optional(),
      plannedEnd: z.string().trim().max(80).nullable().optional(),
      status: z.enum(['planned', 'active', 'paused', 'completed', 'cancelled', 'skipped']).optional(),
      priority: z.number().int().min(-100).max(100).optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'invalid_life_plan', message: parsed.error.message.slice(0, 300) };
    }
    const existing = repos.life.getPlan(id);
    if (!existing) {
      reply.code(404);
      return { error: 'life_plan_not_found' };
    }
    if (existing.status === 'completed') {
      reply.code(409);
      return { error: 'immutable', message: '已完成计划的历史不允许直接篡改' };
    }
    const plan = repos.life.updatePlan(id, {
      ...parsed.data,
      planned_start: parsed.data.plannedStart,
      planned_end: parsed.data.plannedEnd
    });
    if (!plan) {
      reply.code(404);
      return { error: 'life_plan_not_found' };
    }
    repos.audit.add('life', 'plan.updated', plan.id, { status: plan.status });
    services.bus.publish('life.updated', { plan: plan.id });
    return { plan };
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
        tzOffsetMinutes: settings.tzOffsetMinutes,
        proactiveMode: settings.proactiveMode ?? 'auto'
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
      to: q.to,
      // 头像图片默认不进图库；`avatar=1` 是排查用的显式入口，只列头像。
      avatar: q.avatar === '1' || q.avatar === 'true'
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
  /*
   * Legacy admin voice endpoints (voice-system convergence): the standalone
   * 「情绪语音」 panel is gone, and TTS provider parameters live in
   * 「模型配置 → 语音合成」. GET/PUT are kept for old configs and read-only
   * compatibility — nothing new depends on them, and PUT only writes what
   * runtime V2 already ignores (voice.emotions presets, voicePolicy.frequency).
   */
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
    // Fish preview runs the same single cue compile as the production
    // pipeline; other providers keep the legacy preset-driven delivery.
    let options: Record<string, unknown> | undefined;
    let previewText = parsed.data.text;
    if (tts.name === 'fish') {
      const spec = fishCueForMood(parsed.data.emotion, {
        intensity: 1,
        moodAlias: parsed.data.emotion,
        fallbackSpeed: config.getModels().tts.speed
      });
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
