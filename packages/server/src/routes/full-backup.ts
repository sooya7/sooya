import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SooyaApp } from '../app.js';
import { createIpaMigrationArchive, type IpaMigrationSecretsPayload } from '../backup/ipa-export.js';

const FULL_BACKUP_MAX_BYTES = 512 * 1024 * 1024;
const installed = new WeakSet<object>();

type AdminGuard = (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;
type IpaMigrationTransferPayload = IpaMigrationSecretsPayload & {
  models: Record<string, unknown>;
  presets: Array<Record<string, unknown>>;
};

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
        secrets: collectIpaMigrationTransfer(app),
        maxBytes: FULL_BACKUP_MAX_BYTES
      });
      app.repos.audit.add('backup', 'ipa-exported', archive.name, {
        schemaVersion: archive.schemaVersion,
        bytes: archive.bytes,
        fileCount: archive.fileCount,
        memoriesIncluded: false,
        stickersIncluded: false,
        modelsIncluded: true,
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

/**
 * The server keeps models in CONFIG_DIR/models.json rather than SQLite. Put a
 * sanitized copy beside the plaintext key payload that already rides in the
 * migration-only settings row. `createIpaMigrationArchive()` serializes the
 * object as-is, so the IPA Web importer can rebuild provider_configs after the
 * v35 -> current schema upgrade without changing Native Base 11.
 */
function collectIpaMigrationTransfer(app: SooyaApp): IpaMigrationTransferPayload {
  const rawModels = app.config.getModels() as unknown as Record<string, unknown>;
  const providerKeys: Record<string, string> = {};
  const slots = ['chat', 'vision', 'summary', 'director', 'embedding', 'image', 'tts', 'rerank'] as const;
  for (const slot of slots) {
    const section = recordValue(rawModels[slot]);
    const key = stringValue(section.apiKey);
    if (key) providerKeys[slot] = key;
  }

  // Older server configurations can still keep the sticker model as its own
  // section. IPA uses the director slot for sticker/director decisions, so use
  // that key only when director itself does not already have one.
  if (!providerKeys.director) {
    const stickerKey = stringValue(recordValue(rawModels.sticker).apiKey);
    if (stickerKey) providerKeys.director = stickerKey;
  }

  const webSearch = recordValue(rawModels.webSearch);
  const webSearchKeys: Record<string, string> = {};
  const doubaoKey = stringValue(recordValue(webSearch.doubao).apiKey);
  const tavilyKey = stringValue(recordValue(webSearch.tavily).apiKey);
  if (doubaoKey) webSearchKeys.doubao = doubaoKey;
  if (tavilyKey) webSearchKeys.tavily = tavilyKey;

  const mcpTokens: Record<string, string> = {};
  const ombreToken = app.env.OMBRE_MCP_TOKEN?.trim();
  if (ombreToken) mcpTokens.ombre = ombreToken;

  const models = recordValue(sanitizeMigrationConfig(rawModels));
  const rawPresets = app.repos.settings.get<unknown>('models.presets', []);
  const presets = Array.isArray(rawPresets)
    ? rawPresets.map(sanitizeMigrationConfig).filter(isRecord)
    : [];

  return { version: 1, providerKeys, webSearchKeys, mcpTokens, models, presets };
}

/** Never move deployment indirection or duplicate secret material as config. */
function sanitizeMigrationConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeMigrationConfig);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'apiKey' || key === 'apiKeyEnv') continue;
    out[key] = sanitizeMigrationConfig(child);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
