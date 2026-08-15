import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { checkIntegrity } from '../db/index.js';
import { LATEST_VERSION } from '../db/migrations.js';
import type { DbHandle } from '../db/handle.js';
import type { MaintenanceCoordinator } from '../core/maintenance.js';
import { ensureDirSync, atomicWriteFile, dirSize } from '../util/fsx.js';
import { sha256 } from '../util/ids.js';
import { createStoredZip, extractZip, type ZipSource } from './zip.js';

export interface BackupInfo {
  name: string;
  path: string;
  bytes: number;
  createdAt: string;
  sha256: string;
  verified: boolean;
  mediaArchived: boolean;
}

export interface BackupResult extends BackupInfo {
  durationMs: number;
}

export interface FullBackupExportResult {
  name: string;
  path: string;
  bytes: number;
  fileCount: number;
  sha256: string;
  createdAt: string;
  schemaVersion: number;
  mediaIncluded: true;
  format: 'sooya-server-full-backup/v1';
}

export interface FullBackupImportResult {
  imported: true;
  createdAt: string;
  schemaVersion: number;
  fileCount: number;
  bytes: number;
  safetyBackup: string;
}

interface FullBackupManifest {
  format: 'sooya-server-full-backup/v1';
  createdAt: string;
  schemaVersion: number;
  mediaIncluded: true;
  databaseFile: 'database.sqlite3';
  mediaLayout: 'server-v1';
  source: 'server';
}

const FULL_BACKUP_FORMAT = 'sooya-server-full-backup/v1' as const;
const PRIMARY_MEDIA_DIRS = ['images', 'audio', 'stickers', 'files'] as const;

/**
 * Backups of the chat/memory database plus a manifest of the media tree.
 * Uses SQLite's online backup API so it is safe while the server is running,
 * then verifies the copy with integrity_check before keeping it.
 *
 * The legacy .db methods below remain disaster-recovery snapshots. Full ZIP
 * import/export is intentionally separate because it also moves primary media.
 */
export class BackupService {
  constructor(
    private readonly opts: {
      db: () => DbHandle;
      dbFile: string;
      backupDir: string;
      mediaDir: string;
      keep: number;
      maintenance: MaintenanceCoordinator;
      closeForRestore?: () => void;
      reopenAfterRestore?: () => void;
      readCounters?: () => { messageSeq: number; eventSeq: number };
      afterRestore?: (before: { messageSeq: number; eventSeq: number }) => void;
      onLog?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
    }
  ) {
    ensureDirSync(opts.backupDir);
  }

  async create(reason = 'manual'): Promise<BackupResult> {
    return await this.opts.maintenance.run('backup.create', () => this.createUnlocked(reason));
  }

  private async createUnlocked(reason: string): Promise<BackupResult> {
    const started = Date.now();
    ensureDirSync(this.opts.backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `sooya-${stamp}.db`;
    const target = path.join(this.opts.backupDir, name);
    const tmp = `${target}.part`;

    await this.opts.db().backup(tmp);

    let verified = false;
    let failure: string | null = null;
    try {
      const probe = new Database(tmp, { readonly: true, fileMustExist: true });
      try {
        failure = checkIntegrity(probe);
        const counts = probe.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number };
        verified = failure === null && typeof counts.c === 'number';
      } finally {
        probe.close();
      }
    } catch (error) {
      failure = (error as Error).message;
    }
    if (!verified) {
      await fsp.rm(tmp, { force: true });
      throw new Error(`backup verification failed: ${failure ?? 'unknown'}`);
    }
    await fsp.rename(tmp, target);

    const data = await fsp.readFile(target);
    const digest = sha256(data);
    const manifest = {
      name,
      createdAt: new Date().toISOString(),
      reason,
      dbBytes: data.byteLength,
      dbSha256: digest,
      mediaBytes: await dirSize(this.opts.mediaDir),
      mediaFiles: await countFiles(this.opts.mediaDir)
    };
    await atomicWriteFile(`${target}.json`, JSON.stringify(manifest, null, 2));
    await atomicWriteFile(`${target}.sha256`, `${digest}  ${name}\n`);

    await this.applyRetention();
    const info: BackupResult = {
      name,
      path: target,
      bytes: data.byteLength,
      createdAt: manifest.createdAt,
      sha256: digest,
      verified: true,
      mediaArchived: false,
      durationMs: Date.now() - started
    };
    this.opts.onLog?.('info', 'backup created', { name, bytes: data.byteLength, reason });
    return info;
  }

  async list(): Promise<BackupInfo[]> {
    ensureDirSync(this.opts.backupDir);
    const names = (await fsp.readdir(this.opts.backupDir)).filter((name) => name.endsWith('.db'));
    const out: BackupInfo[] = [];
    for (const name of names) {
      const full = path.join(this.opts.backupDir, name);
      try {
        const stat = await fsp.stat(full);
        let digest = '';
        try {
          digest = (await fsp.readFile(`${full}.sha256`, 'utf8')).split(/\s+/)[0] ?? '';
        } catch {
          /* checksum is optional for old backups */
        }
        out.push({
          name,
          path: full,
          bytes: stat.size,
          createdAt: stat.mtime.toISOString(),
          sha256: digest,
          verified: digest.length === 64,
          mediaArchived: false
        });
      } catch {
        /* raced with retention or deletion */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async verify(name: string): Promise<{ ok: boolean; detail: string }> {
    const full = path.join(this.opts.backupDir, path.basename(name));
    if (!fs.existsSync(full)) return { ok: false, detail: 'backup not found' };
    try {
      const data = await fsp.readFile(full);
      const digest = sha256(data);
      let expected = '';
      try {
        expected = (await fsp.readFile(`${full}.sha256`, 'utf8')).split(/\s+/)[0] ?? '';
      } catch {
        /* checksum file optional for hand-copied backups */
      }
      if (expected && expected !== digest) return { ok: false, detail: 'checksum mismatch' };
      const probe = new Database(full, { readonly: true, fileMustExist: true });
      try {
        const failure = checkIntegrity(probe);
        if (failure) return { ok: false, detail: failure };
      } finally {
        probe.close();
      }
      return { ok: true, detail: 'ok' };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  async restore(name: string): Promise<{ restored: string; preservedAs: string | null }> {
    return await this.opts.maintenance.run('backup.restore', () => this.restoreUnlocked(name), { blocksWrites: true });
  }

  private async restoreUnlocked(name: string): Promise<{ restored: string; preservedAs: string | null }> {
    const full = path.join(this.opts.backupDir, path.basename(name));
    const check = await this.verify(path.basename(name));
    if (!check.ok) throw new Error(`refusing to restore invalid backup: ${check.detail}`);

    const before = this.opts.readCounters?.() ?? { messageSeq: 0, eventSeq: 0 };
    this.opts.closeForRestore?.();
    let reopened = false;
    try {
      let preservedAs: string | null = null;
      if (fs.existsSync(this.opts.dbFile)) {
        preservedAs = `${this.opts.dbFile}.pre-restore-${Date.now()}`;
        await fsp.copyFile(this.opts.dbFile, preservedAs);
        for (const suffix of ['-wal', '-shm']) {
          const side = `${this.opts.dbFile}${suffix}`;
          if (fs.existsSync(side)) await fsp.copyFile(side, `${preservedAs}${suffix}`);
        }
      }
      for (const suffix of ['-wal', '-shm']) await fsp.rm(`${this.opts.dbFile}${suffix}`, { force: true });
      await fsp.copyFile(full, this.opts.dbFile);
      this.opts.reopenAfterRestore?.();
      reopened = true;
      this.opts.afterRestore?.(before);
      this.opts.onLog?.('warn', 'database restored from backup', { name });
      return { restored: full, preservedAs };
    } finally {
      if (!reopened) this.opts.reopenAfterRestore?.();
    }
  }

  /**
   * Portable server backup: SQLite snapshot + primary media + manifest in one
   * ZIP. Server credentials and .env are deliberately excluded.
   */
  async createFullArchive(maxBytes = 512 * 1024 * 1024): Promise<FullBackupExportResult> {
    return await this.opts.maintenance.run('backup.full-export', async () => {
      const id = randomUUID().toLowerCase();
      const staging = path.join(this.opts.backupDir, `.full-export-${id}`);
      const exportDir = path.join(this.opts.backupDir, '.exports');
      await fsp.mkdir(staging, { recursive: true });
      await fsp.mkdir(exportDir, { recursive: true });
      try {
        const databaseFile = path.join(staging, 'database.sqlite3');
        await this.opts.db().backup(databaseFile);
        assertValidDatabase(databaseFile);

        const createdAt = new Date().toISOString();
        const manifest: FullBackupManifest = {
          format: FULL_BACKUP_FORMAT,
          createdAt,
          schemaVersion: LATEST_VERSION,
          mediaIncluded: true,
          databaseFile: 'database.sqlite3',
          mediaLayout: 'server-v1',
          source: 'server'
        };
        const manifestFile = path.join(staging, 'manifest.json');
        await atomicWriteFile(manifestFile, JSON.stringify(manifest, null, 2));

        const sources: ZipSource[] = [
          { name: 'manifest.json', path: manifestFile },
          { name: 'database.sqlite3', path: databaseFile },
          ...(await collectPrimaryMedia(this.opts.mediaDir))
        ];
        let sourceBytes = 0;
        for (const source of sources) sourceBytes += (await fsp.stat(source.path)).size;
        if (sourceBytes > maxBytes) throw new Error(`完整备份超过大小限制：${sourceBytes} > ${maxBytes}`);

        const formatter = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        const name = `SOOYA-server-backup-${formatter}-${id.slice(0, 8)}.zip`;
        const target = path.join(exportDir, name);
        const zip = await createStoredZip(sources, target);
        if (zip.bytes > maxBytes) {
          await fsp.rm(target, { force: true });
          throw new Error(`完整备份超过大小限制：${zip.bytes} > ${maxBytes}`);
        }
        const digest = await sha256File(target);
        this.opts.onLog?.('info', 'full backup exported', { name, bytes: zip.bytes, fileCount: zip.fileCount });
        return {
          name,
          path: target,
          bytes: zip.bytes,
          fileCount: zip.fileCount,
          sha256: digest,
          createdAt,
          schemaVersion: LATEST_VERSION,
          mediaIncluded: true,
          format: FULL_BACKUP_FORMAT
        };
      } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }, { blocksWrites: true });
  }

  /**
   * Restores a server full-backup ZIP transactionally enough for a single-node
   * deployment: validate in staging, create an ordinary DR backup, then swap DB
   * + media. Any failure restores both old DB and old media before returning.
   */
  async importFullArchive(archive: string, maxBytes = 512 * 1024 * 1024): Promise<FullBackupImportResult> {
    return await this.opts.maintenance.run('backup.full-import', async () => {
      const id = randomUUID().toLowerCase();
      const staging = path.join(this.opts.backupDir, `.full-import-${id}`);
      const before = this.opts.readCounters?.() ?? { messageSeq: 0, eventSeq: 0 };
      let preservedDb: string | null = null;
      let preservedMedia: string | null = null;
      let liveOpen = true;
      let safety: BackupResult | null = null;
      try {
        const extracted = await extractZip(archive, staging, { maxBytes, maxFiles: 10_000 });
        const manifest = await readFullManifest(path.join(staging, 'manifest.json'));
        if (manifest.schemaVersion > LATEST_VERSION) {
          throw new Error(`备份数据库版本 v${manifest.schemaVersion} 高于当前服务器 v${LATEST_VERSION}，请先升级服务器`);
        }
        const incomingDb = path.join(staging, manifest.databaseFile);
        assertValidDatabase(incomingDb);
        const incomingMedia = path.join(staging, 'Media');
        const mediaStat = await fsp.stat(incomingMedia).catch(() => null);
        if (!mediaStat?.isDirectory()) throw new Error('完整备份缺少 Media 目录');
        for (const dir of PRIMARY_MEDIA_DIRS) {
          const candidate = path.join(incomingMedia, dir);
          const stat = await fsp.stat(candidate).catch(() => null);
          if (stat && !stat.isDirectory()) throw new Error(`备份媒体目录无效：Media/${dir}`);
        }

        // Keep a normal retained .db backup as the operator-visible safety net.
        safety = await this.createUnlocked('pre-full-import');
        this.opts.closeForRestore?.();
        liveOpen = false;

        const stamp = Date.now();
        if (fs.existsSync(this.opts.dbFile)) {
          preservedDb = `${this.opts.dbFile}.pre-full-import-${stamp}`;
          await fsp.copyFile(this.opts.dbFile, preservedDb);
        }
        preservedMedia = `${this.opts.mediaDir}.pre-full-import-${stamp}`;
        await fsp.rm(preservedMedia, { recursive: true, force: true });
        if (fs.existsSync(this.opts.mediaDir)) await fsp.rename(this.opts.mediaDir, preservedMedia);

        for (const suffix of ['-wal', '-shm']) await fsp.rm(`${this.opts.dbFile}${suffix}`, { force: true });
        await fsp.copyFile(incomingDb, this.opts.dbFile);
        await fsp.rename(incomingMedia, this.opts.mediaDir);
        ensureServerMediaDirs(this.opts.mediaDir);

        this.opts.reopenAfterRestore?.();
        liveOpen = true;
        const failure = checkIntegrity(this.opts.db().raw);
        if (failure) throw new Error(`导入后数据库校验失败：${failure}`);
        this.opts.afterRestore?.(before);

        if (preservedDb) await fsp.rm(preservedDb, { force: true });
        if (preservedMedia) await fsp.rm(preservedMedia, { recursive: true, force: true });
        this.opts.onLog?.('warn', 'full backup imported', { schemaVersion: manifest.schemaVersion, safetyBackup: safety.name });
        return {
          imported: true,
          createdAt: manifest.createdAt,
          schemaVersion: manifest.schemaVersion,
          fileCount: extracted.fileCount,
          bytes: extracted.bytes,
          safetyBackup: safety.name
        };
      } catch (error) {
        const swapped = preservedDb !== null || preservedMedia !== null;
        if (swapped) {
          try {
            if (liveOpen) {
              this.opts.closeForRestore?.();
              liveOpen = false;
            }
            for (const suffix of ['', '-wal', '-shm']) await fsp.rm(`${this.opts.dbFile}${suffix}`, { force: true });
            if (preservedDb && fs.existsSync(preservedDb)) await fsp.copyFile(preservedDb, this.opts.dbFile);
            await fsp.rm(this.opts.mediaDir, { recursive: true, force: true });
            if (preservedMedia && fs.existsSync(preservedMedia)) await fsp.rename(preservedMedia, this.opts.mediaDir);
            ensureServerMediaDirs(this.opts.mediaDir);
            this.opts.reopenAfterRestore?.();
            liveOpen = true;
            this.opts.afterRestore?.(before);
          } catch (rollbackError) {
            this.opts.onLog?.('error', 'full backup rollback failed', { error: (rollbackError as Error).message });
            throw new Error(`完整备份导入失败，且自动回滚失败：${(rollbackError as Error).message}; 原始错误：${(error as Error).message}`);
          }
        }
        throw error;
      } finally {
        if (!liveOpen) {
          try {
            this.opts.reopenAfterRestore?.();
            this.opts.afterRestore?.(before);
          } catch {
            /* The original error is more useful; startup recovery remains available. */
          }
        }
        if (preservedDb) await fsp.rm(preservedDb, { force: true }).catch(() => undefined);
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }, { blocksWrites: true });
  }

  async remove(name: string): Promise<boolean> {
    return await this.opts.maintenance.run('backup.delete', async () => {
      if (!/^sooya-[\w.-]+\.db$/.test(name)) return false;
      const full = path.join(this.opts.backupDir, path.basename(name));
      if (!fs.existsSync(full)) return false;
      await fsp.rm(full, { force: true });
      await fsp.rm(`${full}.json`, { force: true });
      await fsp.rm(`${full}.sha256`, { force: true });
      return true;
    });
  }

  private async applyRetention(): Promise<void> {
    const all = await this.list();
    const extra = all.slice(this.opts.keep);
    for (const backup of extra) {
      await fsp.rm(backup.path, { force: true });
      await fsp.rm(`${backup.path}.json`, { force: true });
      await fsp.rm(`${backup.path}.sha256`, { force: true });
    }
  }
}

function assertValidDatabase(file: string): void {
  const probe = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const failure = checkIntegrity(probe);
    if (failure) throw new Error(`database integrity check failed: ${failure}`);
    const row = probe.prepare('SELECT COUNT(*) c FROM messages').get() as { c?: unknown };
    if (typeof row.c !== 'number') throw new Error('messages table is unavailable');
  } finally {
    probe.close();
  }
}

async function readFullManifest(file: string): Promise<FullBackupManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    throw new Error('完整备份缺少或无法读取 manifest.json');
  }
  const manifest = value as Partial<FullBackupManifest> | null;
  if (!manifest || typeof manifest !== 'object' ||
      manifest.format !== FULL_BACKUP_FORMAT ||
      typeof manifest.createdAt !== 'string' || !manifest.createdAt ||
      !Number.isInteger(manifest.schemaVersion) || Number(manifest.schemaVersion) <= 0 ||
      manifest.mediaIncluded !== true || manifest.databaseFile !== 'database.sqlite3' ||
      manifest.mediaLayout !== 'server-v1' || manifest.source !== 'server') {
    throw new Error('这不是 SOOYA 服务器版完整备份，或备份格式已损坏');
  }
  return manifest as FullBackupManifest;
}

async function collectPrimaryMedia(mediaDir: string): Promise<ZipSource[]> {
  const sources: ZipSource[] = [];
  for (const top of PRIMARY_MEDIA_DIRS) {
    const root = path.join(mediaDir, top);
    const stat = await fsp.stat(root).catch(() => null);
    if (!stat?.isDirectory()) continue;
    const stack: Array<{ absolute: string; relative: string }> = [{ absolute: root, relative: top }];
    while (stack.length) {
      const current = stack.pop()!;
      for (const entry of await fsp.readdir(current.absolute, { withFileTypes: true })) {
        const absolute = path.join(current.absolute, entry.name);
        const relative = path.posix.join(current.relative.split(path.sep).join('/'), entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push({ absolute, relative });
        else if (entry.isFile()) sources.push({ name: `Media/${relative}`, path: absolute });
      }
    }
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

function ensureServerMediaDirs(mediaDir: string): void {
  ensureDirSync(mediaDir);
  for (const dir of [...PRIMARY_MEDIA_DIRS, 'tmp', 'variants']) ensureDirSync(path.join(mediaDir, dir));
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else count++;
    }
  }
  return count;
}
