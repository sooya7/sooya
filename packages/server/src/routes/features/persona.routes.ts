import fs from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import type { SooyaApp } from '../../app.js';
import { resolveReferencesDir } from '../../app.js';
import { requireAdminToken } from '../auth.js';
import type { MediaRow } from '../../db/repos/media.repo.js';
import { classifyFraming } from '../../media/persona-references.js';
import { atomicWriteFile, ensureDirSync, safeJoin } from '../../util/fsx.js';
import { galleryItem, mediaIdFromUrl, sanitizeName } from './shared.js';

export function registerPersonaRoutes(app: SooyaApp): void {
  const { server, repos, services, config } = app;
  const admin = requireAdminToken(app);
  const adminGuard = { preHandler: admin };

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

  const refNameRe = /^[A-Za-z0-9._-]{1,120}$/u;
  const refMimeByExt: Record<string, string> = {
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
        if (!refMimeByExt[path.extname(entry).toLowerCase()]) continue;
        if (!seen.has(entry)) seen.set(entry, refItem(dir, entry, false));
      }
    }
    return { dir, references: [...seen.values()] };
  });

  server.post('/api/admin/persona/references', adminGuard, async (req, reply) => {
    const dir = resolveReferencesDir(app.env);
    if (!dir) {
      reply.code(507);
      return { error: 'references_dir_unavailable', message: '参考图目录不可用，请检查 SOOYA_REFERENCES_DIR。' };
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
      const sniffed = await fileTypeFromBuffer(buffer);
      if (!sniffed || !refMimeByExt[`.${sniffed.ext}`]) {
        reply.code(415);
        return { error: 'unsupported_image', message: '只支持 PNG / JPG / WEBP / GIF 图片。' };
      }
      const base = path.basename(filename).replace(/\.[^.]+$/u, '').replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 80) || 'reference';
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

  const slotNameByFraming: Record<string, string> = { front: 'ref_front', 'full-body': 'ref_full_body', side: 'ref_side' };
  server.post('/api/admin/persona/references/slot/:framing', adminGuard, async (req, reply) => {
    const framing = (req.params as { framing: string }).framing;
    const slotBase = slotNameByFraming[framing];
    if (!slotBase) {
      reply.code(400);
      return { error: 'bad_framing', message: '视角只能是 front、full-body 或 side。' };
    }
    const dir = resolveReferencesDir(app.env);
    if (!dir) {
      reply.code(507);
      return { error: 'references_dir_unavailable', message: '参考图目录不可用，请检查 SOOYA_REFERENCES_DIR。' };
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
      if (!sniffed || !refMimeByExt[`.${sniffed.ext}`]) {
        reply.code(415);
        return { error: 'unsupported_image', message: '只支持 PNG / JPG / WEBP / GIF 图片。' };
      }
      const name = `${slotBase}.${sniffed.ext}`;
      ensureDirSync(dir);
      await atomicWriteFile(safeJoin(dir, name), buffer);
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
    if (!refNameRe.test(name) || !dir) {
      reply.code(400);
      return { error: 'bad_name' };
    }
    let file: string;
    try { file = safeJoin(dir, name); } catch { reply.code(400); return { error: 'bad_name' }; }
    if (!fs.existsSync(file)) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const stat = fs.statSync(file);
    const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(36)}"`;
    const lastModified = stat.mtime.toUTCString();
    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = req.headers['if-modified-since'];
    if ((typeof ifNoneMatch === 'string' && ifNoneMatch === etag) || (!ifNoneMatch && typeof ifModifiedSince === 'string' && ifModifiedSince === lastModified)) {
      return reply.code(304).header('cache-control', 'private, no-cache').header('etag', etag).header('last-modified', lastModified).send();
    }
    const mime = refMimeByExt[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
    return reply.type(mime)
      .header('cache-control', 'private, no-cache')
      .header('etag', etag)
      .header('last-modified', lastModified)
      .send(fs.createReadStream(file));
  });

  server.delete('/api/admin/persona/references/:name', adminGuard, async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!refNameRe.test(name)) {
      reply.code(400);
      return { error: 'bad_name' };
    }
    const current = config.getPersona().referenceImages;
    if (current.includes(name)) config.setPersona({ referenceImages: current.filter((n) => n !== name) });
    const dir = resolveReferencesDir(app.env);
    let removedFile = false;
    if (dir) {
      try { fs.unlinkSync(safeJoin(dir, name)); removedFile = true; } catch { /* already gone */ }
    }
    repos.audit.add('persona', 'reference.deleted', name, { removedFile });
    return { deleted: true, removedFile, referenceImages: config.getPersona().referenceImages };
  });
}
