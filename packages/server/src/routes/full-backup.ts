import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SooyaApp } from '../app.js';
import { createIpaMigrationArchive, type IpaMigrationSecretsPayload } from '../backup/ipa-export.js';

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
        secrets: collectIpaMigrationSecrets(app),
        maxBytes: FULL_BACKUP_MAX_BYTES
      });
      app.repos.audit.add('backup', 'ipa-exported', archive.name, {
        schemaVersion: archive.schemaVersion,
        bytes: archive.bytes,
        fileCount: archive.fileCount,
        memoriesIncluded: false,
        stickersIncluded: false,
        plainSecretsIncluded: archive.plainSecretsIncluded
      });
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Length', String(archive.bytes));
      reply.header('Content-Disposition', `attachment; filename="${archive.name}"`);
      reply.header('X-SOOYA-Backup-SHA256', archive.sha256);
      reply.header('X-SOOYA-Backup-Target', 'ipa');
      reply.header('X-SOOYA-Backup-Plain-Secrets', archive.plainSecretsIncluded ? '1' : '0');
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

function collectIpaMigrationSecrets(app: SooyaApp): IpaMigrationSecretsPayload {
  const models = app.config.getModels() as unknown as Record<string, unknown>;
  const providerKeys: Record<string, string> = {};
  const slots = ['chat', 'vision', 'summary', 'director', 'embedding', 'image', 'tts', 'rerank'] as const;
  for (const slot of slots) {
    const section = recordValue(models[slot]);
    const key = stringValue(section.apiKey);
    if (key) providerKeys[slot] = key;
  }

  // Older server configurations can still keep the sticker model as its own
  // section. IPA uses the director slot for sticker/director decisions, so use
  // that key only when director itself does not already have one.
  if (!providerKeys.director) {
    const stickerKey = stringValue(recordValue(models.sticker).apiKey);
    if (stickerKey) providerKeys.director = stickerKey;
  }

  const webSearch = recordValue(models.webSearch);
  const webSearchKeys: Record<string, string> = {};
  const doubaoKey = stringValue(recordValue(webSearch.doubao).apiKey);
  const tavilyKey = stringValue(recordValue(webSearch.tavily).apiKey);
  if (doubaoKey) webSearchKeys.doubao = doubaoKey;
  if (tavilyKey) webSearchKeys.tavily = tavilyKey;

  const mcpTokens: Record<string, string> = {};
  const ombreToken = app.env.OMBRE_MCP_TOKEN?.trim();
  if (ombreToken) mcpTokens.ombre = ombreToken;

  return { version: 1, providerKeys, webSearchKeys, mcpTokens };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
