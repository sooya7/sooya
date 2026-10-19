import type { SooyaApp } from '../../app.js';
import { requireAdminToken } from '../auth.js';
import type { MediaRow } from '../../db/repos/media.repo.js';
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
}
