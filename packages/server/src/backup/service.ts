import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { checkIntegrity } from '../db/index.js';
import type { DbHandle } from '../db/handle.js';
import type { MaintenanceCoordinator } from '../core/maintenance.js';
import { ensureDirSync, atomicWriteFile, dirSize } from '../util/fsx.js';
import { sha256 } from '../util/ids.js';

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

/**
 * Backups of the chat/memory database plus a manifest of the media tree.
 * Uses SQLite's online backup API so it is safe while the server is running,
 * then verifies the copy with integrity_check before keeping it.
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

  /**
   * §36 backup manifest: db checksum, WAL mode, and a per-file media manifest
   * so a restore can be checked against what it is supposed to contain.
   */
  private async buildManifest(
    name: string,
    reason: string,
    dbBytes: number,
    digest: string
  ): Promise<{
    name: string;
    createdAt: string;
    reason: string;
    dbBytes: number;
    dbSha256: string;
    walMode: string;
    mediaBytes: number;
    mediaFiles: number;
    mediaManifest: Array<{ path: string; bytes: number }>;
    mediaManifestTruncated: boolean;
  }> {
    let walMode = 'unknown';
    try {
      walMode = String((this.opts.db().pragma('journal_mode') as unknown as Array<{ journal_mode?: string }>)[0]?.journal_mode ?? 'unknown');
    } catch {
      /* manifest-only */
    }
    const files: Array<{ path: string; bytes: number }> = [];
    let mediaBytes = 0;
    const walk = async (dir: string, prefix = ''): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), rel);
        } else {
          let bytes = 0;
          try {
            bytes = (await fsp.stat(path.join(dir, entry.name))).size;
          } catch {
            /* vanished mid-walk */
          }
          mediaBytes += bytes;
          files.push({ path: rel, bytes });
        }
      }
    };
    await walk(this.opts.mediaDir);
    const cap = 2000;
    return {
      name,
      createdAt: new Date().toISOString(),
      reason,
      dbBytes,
      dbSha256: digest,
      walMode,
      mediaBytes,
      mediaFiles: files.length,
      mediaManifest: files.slice(0, cap),
      mediaManifestTruncated: files.length > cap
    };
  }

  /**
   * §36 restore-time integrity report — REPORT ONLY: nothing is deleted or
   * rewritten here. Checks both directions: media referenced by the database
   * that is missing on disk, and files with no database reference.
   */
  async integrityReport(): Promise<{
    referencedMediaMissing: Array<{ id: string; relPath: string }>;
    orphanFiles: string[];
    danglingMessageMedia: Array<{ messageId: string; mediaId: string }>;
  }> {
    const db = this.opts.db();
    const mediaRows = db.prepare('SELECT id, rel_path FROM media').all() as Array<{ id: string; rel_path: string }>;
    const onDisk = new Set<string>();
    const walk = async (dir: string, prefix = ''): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
        else onDisk.add(rel);
      }
    };
    await walk(this.opts.mediaDir);

    const referencedMediaMissing: Array<{ id: string; relPath: string }> = [];
    const knownIds = new Set<string>();
    for (const row of mediaRows) {
      knownIds.add(row.id);
      if (!fs.existsSync(path.join(this.opts.mediaDir, row.rel_path))) {
        referencedMediaMissing.push({ id: row.id, relPath: row.rel_path });
      }
    }
    const orphanFiles = [...onDisk].filter(
      (rel) => !mediaRows.some((row) => row.rel_path === rel)
    );
    const danglingMessageMedia = (
      db.prepare("SELECT message_id, media_id FROM message_parts WHERE media_id IS NOT NULL").all() as Array<{
        message_id: string;
        media_id: string;
      }>
    )
      .filter((row) => !knownIds.has(row.media_id))
      .map((row) => ({ messageId: row.message_id, mediaId: row.media_id }));
    return { referencedMediaMissing, orphanFiles, danglingMessageMedia };
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
    const manifest = await this.buildManifest(name, reason, data.byteLength, digest);
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
