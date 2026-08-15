import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SooyaApp } from '../app.js';
import { createIpaMigrationArchive } from '../backup/ipa-export.js';

const FULL_BACKUP_MAX_BYTES = 512 * 1024 * 1024;
const installed = new WeakSet<object>();

type AdminGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;

/**
 * Server -> IPA migration export. This intentionally does not expose a ZIP
 * import endpoint on the server: the portable archive's destination is the
 * IPA's existing native import flow. Ordinary server disaster recovery keeps
 * using the established .db backup endpoints.
 */
export function ensureFullBackupRoutes(app: SooyaApp, admin: AdminGuard): void {
  if (installed.has(app.server)) return;
  installed.add(app.server);

  app.server.get('/api/admin/full-backup/export', { preHandler: admin }, async (_req, reply) => {
    let archive: Awaited<ReturnType<typeof createIpaMigrationArchive>> | null = null;
    try {
      archive = await createIpaMigrationArchive({
        db: app.db,
        backupDir: app.env.backupDir,
        mediaDir: app.env.mediaDir,
        maxBytes: FULL_BACKUP_MAX_BYTES
      });
      app.repos.audit.add('backup', 'ipa-exported', archive.name, {
        schemaVersion: archive.schemaVersion,
        bytes: archive.bytes,
        fileCount: archive.fileCount,
        memoriesIncluded: false,
        stickersIncluded: false
      });
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Length', String(archive.bytes));
      reply.header('Content-Disposition', `attachment; filename="${archive.name}"`);
      reply.header('X-SOOYA-Backup-SHA256', archive.sha256);
      reply.header('X-SOOYA-Backup-Target', 'ipa');
      const stream = fs.createReadStream(archive.path);
      stream.once('close', () => { void fsp.rm(archive!.path, { force: true }); });
      return reply.send(stream);
    } catch (error) {
      if (archive) await fsp.rm(archive.path, { force: true }).catch(() => undefined);
      reply.code(500);
      return { error: 'ipa_export_failed', message: (error as Error).message };
    }
  });
}
