import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SooyaApp } from '../app.js';

const FULL_BACKUP_MAX_BYTES = 512 * 1024 * 1024;
const installed = new WeakSet<object>();

type AdminGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;

/**
 * Installed once by the admin auth surface so full backup routes stay separate
 * from the already-large admin.ts module while sharing exactly the same guard.
 */
export function ensureFullBackupRoutes(app: SooyaApp, admin: AdminGuard): void {
  if (installed.has(app.server)) return;
  installed.add(app.server);
  const { server, services, repos } = app;

  server.get('/api/admin/full-backup/export', { preHandler: admin }, async (_req, reply) => {
    let archive: Awaited<ReturnType<typeof services.backups.createFullArchive>> | null = null;
    try {
      archive = await services.backups.createFullArchive(FULL_BACKUP_MAX_BYTES);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Length', String(archive.bytes));
      reply.header('Content-Disposition', `attachment; filename="${archive.name}"`);
      reply.header('X-SOOYA-Backup-SHA256', archive.sha256);
      const stream = fs.createReadStream(archive.path);
      stream.once('close', () => { void fsp.rm(archive!.path, { force: true }); });
      return reply.send(stream);
    } catch (error) {
      if (archive) await fsp.rm(archive.path, { force: true }).catch(() => undefined);
      reply.code(500);
      return { error: 'full_backup_export_failed', message: (error as Error).message };
    }
  });

  server.post('/api/admin/full-backup/import', {
    preHandler: admin,
    bodyLimit: FULL_BACKUP_MAX_BYTES + 1024 * 1024
  }, async (req, reply) => {
    const imports = path.join(app.env.backupDir, '.imports');
    await fsp.mkdir(imports, { recursive: true });
    const incoming = path.join(imports, `incoming-${randomUUID().toLowerCase()}.zip`);
    try {
      const part = await req.file({ limits: { files: 1, fileSize: FULL_BACKUP_MAX_BYTES } });
      if (!part) {
        reply.code(400);
        return { error: 'backup_file_required', message: '请选择要导入的 SOOYA 完整备份 ZIP' };
      }
      if (!part.filename.toLowerCase().endsWith('.zip')) {
        part.file.resume();
        reply.code(400);
        return { error: 'invalid_backup_file', message: '完整备份必须是 .zip 文件' };
      }
      const handle = await fsp.open(incoming, 'wx');
      try {
        for await (const chunk of part.file) await handle.write(chunk as Buffer);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (part.file.truncated) {
        reply.code(413);
        return { error: 'backup_too_large', message: '完整备份超过 512 MB 限制' };
      }

      const result = await services.backups.importFullArchive(incoming, FULL_BACKUP_MAX_BYTES);
      repos.audit.add('backup', 'full-imported', part.filename, {
        schemaVersion: result.schemaVersion,
        safetyBackup: result.safetyBackup,
        bytes: result.bytes,
        fileCount: result.fileCount
      });
      services.bus.publish('system.notice', {
        notice: 'full backup imported',
        reason: 'full-backup-imported',
        action: 'reload',
        lastMessageSeq: repos.messages.maxSeq()
      });
      return result;
    } catch (error) {
      reply.code(400);
      return { error: 'full_backup_import_failed', message: (error as Error).message };
    } finally {
      await fsp.rm(incoming, { force: true }).catch(() => undefined);
    }
  });
}
