import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { DbHandle } from '../db/handle.js';
import { checkIntegrity } from '../db/index.js';
import { LATEST_VERSION } from '../db/migrations.js';
import { maintenanceCoordinator } from '../core/maintenance.js';
import { atomicWriteFile } from '../util/fsx.js';
import { createStoredZip, type ZipSource } from './zip.js';

const FORMAT = 'sooya-full-backup/v1' as const;

interface MediaRow {
  id: string;
  kind: 'image' | 'audio' | 'sticker' | 'file';
  rel_path: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  created_at: string;
  meta_json: string;
}

export interface IpaMigrationExportResult {
  name: string;
  path: string;
  bytes: number;
  fileCount: number;
  sha256: string;
  createdAt: string;
  schemaVersion: number;
  mediaIncluded: true;
  format: typeof FORMAT;
  source: 'server';
}

/**
 * Builds a package the IPA importer can consume directly. The live server DB
 * is never modified: all migration-specific cleanup happens in the SQLite
 * snapshot created for the archive.
 *
 * Deliberately excluded:
 * - server memories: IPA keeps its own local/Ombre hybrid memory state
 * - sticker library/binaries: IPA re-seeds its bundled sticker pack on boot
 * - .env, API keys and other server secrets
 */
export async function createIpaMigrationArchive(options: {
  db: DbHandle;
  backupDir: string;
  mediaDir: string;
  maxBytes?: number;
}): Promise<IpaMigrationExportResult> {
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  return await maintenanceCoordinator.run('backup.ipa-export', async () => {
    const id = randomUUID().toLowerCase();
    const staging = path.join(options.backupDir, `.ipa-export-${id}`);
    const exportDir = path.join(options.backupDir, '.exports');
    const objectsDir = path.join(staging, 'Media', 'objects');
    const metadataDir = path.join(staging, 'Media', 'metadata');
    await Promise.all([
      fsp.mkdir(staging, { recursive: true }),
      fsp.mkdir(exportDir, { recursive: true }),
      fsp.mkdir(objectsDir, { recursive: true }),
      fsp.mkdir(metadataDir, { recursive: true })
    ]);

    try {
      const databaseFile = path.join(staging, 'database.sqlite3');
      await options.db.backup(databaseFile);
      const media = prepareMigrationDatabase(databaseFile);

      const sources: ZipSource[] = [];
      for (const row of media) {
        const source = safeMediaPath(options.mediaDir, row.rel_path);
        const stat = await fsp.stat(source).catch(() => null);
        if (!stat?.isFile()) {
          // Keep the snapshot self-consistent: a media row without an object is
          // no more useful on iOS than it was on the server. Convert references
          // to textual placeholders and remove the broken row from the export.
          removeMissingMedia(databaseFile, row.id, row.kind);
          continue;
        }
        const physicalId = randomUUID().toLowerCase();
        setPhysicalMediaId(databaseFile, row.id, physicalId, stat.size);
        sources.push({ name: `Media/objects/${physicalId}`, path: source });

        const sidecar = path.join(metadataDir, `${physicalId}.json`);
        await atomicWriteFile(sidecar, JSON.stringify({
          id: physicalId,
          kind: row.kind,
          mimeType: row.mime || 'application/octet-stream',
          bytes: stat.size,
          originalName: originalName(row),
          createdAt: normalizeIso(row.created_at),
          width: row.width,
          height: row.height,
          durationSeconds: row.duration,
          sourceID: null
        }));
        sources.push({ name: `Media/metadata/${physicalId}.json`, path: sidecar });
      }

      // ZIP writer stores files rather than directory entries. Keep empty Media
      // roots materialized so a text-only history is still accepted by the IPA.
      if (!sources.some((entry) => entry.name.startsWith('Media/objects/'))) {
        const keep = path.join(objectsDir, '.keep');
        await fsp.writeFile(keep, '');
        sources.push({ name: 'Media/objects/.keep', path: keep });
      }
      if (!sources.some((entry) => entry.name.startsWith('Media/metadata/'))) {
        const keep = path.join(metadataDir, '.keep');
        await fsp.writeFile(keep, '');
        sources.push({ name: 'Media/metadata/.keep', path: keep });
      }

      assertValidDatabase(databaseFile);
      const createdAt = new Date().toISOString();
      const manifestFile = path.join(staging, 'manifest.json');
      await atomicWriteFile(manifestFile, JSON.stringify({
        format: FORMAT,
        createdAt,
        schemaVersion: LATEST_VERSION,
        mediaIncluded: true,
        secretsIncluded: false,
        databaseFile: 'database.sqlite3',
        source: 'server',
        migration: {
          stickersIncluded: false,
          memoriesIncluded: false,
          mediaLayout: 'ios-native-v1'
        }
      }, null, 2));

      const archiveSources: ZipSource[] = [
        { name: 'manifest.json', path: manifestFile },
        { name: 'database.sqlite3', path: databaseFile },
        ...sources
      ];
      let expandedBytes = 0;
      for (const source of archiveSources) expandedBytes += (await fsp.stat(source.path)).size;
      if (expandedBytes > maxBytes) throw new Error(`IPA 迁移包超过大小限制：${expandedBytes} > ${maxBytes}`);

      const stamp = createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z');
      const name = `SOOYA-server-to-IPA-${stamp}-${id.slice(0, 8)}.zip`;
      const target = path.join(exportDir, name);
      const zip = await createStoredZip(archiveSources, target);
      if (zip.bytes > maxBytes) {
        await fsp.rm(target, { force: true });
        throw new Error(`IPA 迁移包超过大小限制：${zip.bytes} > ${maxBytes}`);
      }
      return {
        name,
        path: target,
        bytes: zip.bytes,
        fileCount: zip.fileCount,
        sha256: await sha256File(target),
        createdAt,
        schemaVersion: LATEST_VERSION,
        mediaIncluded: true,
        format: FORMAT,
        source: 'server'
      };
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

function prepareMigrationDatabase(file: string): MediaRow[] {
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    const transaction = db.transaction(() => {
      // Keep the chronology of sticker-only messages without moving the sticker
      // library itself. Mixed messages simply lose the sticker attachment.
      db.prepare(`
        UPDATE message_parts
        SET type='text', text=CASE WHEN COALESCE(TRIM(text),'')='' THEN '[表情包]' ELSE text END,
            media_id=NULL, duration=NULL, transcript=NULL, meta_json='{}'
        WHERE media_id IN (SELECT id FROM media WHERE kind='sticker')
      `).run();
      db.prepare('DELETE FROM stickers').run();
      db.prepare("DELETE FROM media WHERE kind='sticker'").run();
      // Make the IPA bundled pack seed itself again after the migrated DB boots.
      db.prepare("DELETE FROM settings WHERE key LIKE 'builtin-stickers:%'").run();

      // Server/Ombre is already the remote memory source for IPA. Do not clone
      // server legacy memory into the phone and create duplicates on first sync.
      if (tableExists(db, 'memory_sources')) db.prepare('DELETE FROM memory_sources').run();
      db.prepare('DELETE FROM memories').run();
      if (tableExists(db, 'ombre_commits')) db.prepare('DELETE FROM ombre_commits').run();
      if (tableExists(db, 'ombre_commit_receipts')) db.prepare('DELETE FROM ombre_commit_receipts').run();
      if (tableExists(db, 'jobs')) db.prepare("DELETE FROM jobs WHERE type LIKE 'memory.%' OR type LIKE 'sticker.%'").run();
      if (tableExists(db, 'memories_fts')) {
        try { db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"); } catch { /* FTS is derived */ }
      }
    });
    transaction();
    return db.prepare("SELECT id,kind,rel_path,mime,bytes,width,height,duration,created_at,meta_json FROM media WHERE kind!='sticker'").all() as MediaRow[];
  } finally {
    db.close();
  }
}

function setPhysicalMediaId(file: string, businessId: string, physicalId: string, bytes: number): void {
  const db = new Database(file, { fileMustExist: true });
  try {
    // Native LocalMediaResolver treats origin='builtin' as a bundle asset and
    // ignores rel_path. A server file is a real imported object on iOS, so any
    // non-sticker builtin row must become ordinary imported media.
    db.prepare("UPDATE media SET rel_path=?, bytes=?, origin=CASE WHEN origin='builtin' THEN 'upload' ELSE origin END WHERE id=?").run(physicalId, bytes, businessId);
  } finally { db.close(); }
}

function removeMissingMedia(file: string, mediaId: string, kind: MediaRow['kind']): void {
  const db = new Database(file, { fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    db.transaction(() => {
      db.prepare(`UPDATE message_parts SET type='text', text=COALESCE(NULLIF(text,''), NULLIF(transcript,''), ?), media_id=NULL, duration=NULL, transcript=NULL WHERE media_id=?`).run(kind === 'audio' ? '[语音]' : kind === 'image' ? '[图片]' : '[文件]', mediaId);
      if (tableExists(db, 'moments')) db.prepare('UPDATE moments SET image_media_id=NULL WHERE image_media_id=?').run(mediaId);
      if (tableExists(db, 'voice_generations')) db.prepare('UPDATE voice_generations SET media_id=NULL WHERE media_id=?').run(mediaId);
      db.prepare('DELETE FROM media WHERE id=?').run(mediaId);
    })();
  } finally { db.close(); }
}

function tableExists(db: BetterSqlite3.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name));
}

function assertValidDatabase(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const failure = checkIntegrity(db);
    if (failure) throw new Error(`IPA 迁移数据库校验失败：${failure}`);
    const row = db.prepare('SELECT COUNT(*) c FROM messages').get() as { c?: unknown };
    if (typeof row.c !== 'number') throw new Error('messages table is unavailable');
  } finally { db.close(); }
}

function safeMediaPath(mediaDir: string, relPath: string): string {
  const root = path.resolve(mediaDir);
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe media path: ${relPath}`);
  return resolved;
}

function originalName(row: MediaRow): string | null {
  try {
    const value = JSON.parse(row.meta_json) as { name?: unknown; originalName?: unknown };
    const candidate = typeof value.name === 'string' ? value.name : typeof value.originalName === 'string' ? value.originalName : null;
    if (candidate?.trim()) return path.basename(candidate.trim()).slice(0, 255);
  } catch { /* legacy metadata */ }
  const base = path.basename(row.rel_path);
  return base && base !== '.' ? base.slice(0, 255) : null;
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  const iso = Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
  return iso.replace(/\.\d{3}Z$/u, 'Z');
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
