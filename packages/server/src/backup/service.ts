import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { checkIntegrity } from '../db/index.js';
import type { DbHandle } from '../db/handle.js';
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
      /**
       * Closes the live connection before the database file is replaced and
       * reopens it afterwards. Without this the open connection would
       * checkpoint its WAL over the freshly restored file and resurrect the
       * very data the restore was meant to roll back.
       */
      closeForRestore?: () => void;
      reopenAfterRestore?: () => void;
      /** Reads the current sequence watermarks before the file is replaced. */
      readCounters?: () => { messageSeq: number; eventSeq: number };
      /** Reconciles counters against the restored data and the old watermarks. */
      afterRestore?: (before: { messageSeq: number; eventSeq: number }) => void;
      onLog?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
    }
  ) {
    ensureDirSync(opts.backupDir);
  }

  async create(reason = 'manual'): Promise<BackupResult> {
    const started = Date.now();
    ensureDirSync(this.opts.backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `sooya-${stamp}.db`;
    const target = path.join(this.opts.backupDir, name);
    const tmp = `${target}.part`;

    await this.opts.db().backup(tmp);

    // Verify before publishing.
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
    } catch (err) {
      failure = (err as Error).message;
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
    const names = (await fsp.readdir(this.opts.backupDir)).filter((n) => n.endsWith('.db'));
    const out: BackupInfo[] = [];
    for (const name of names) {
      const full = path.join(this.opts.backupDir, name);
      try {
        const st = await fsp.stat(full);
        let digest = '';
        try {
          digest = (await fsp.readFile(`${full}.sha256`, 'utf8')).split(/\s+/)[0] ?? '';
        } catch {
          /* ignore */
        }
        out.push({
          name,
          path: full,
          bytes: st.size,
          createdAt: st.mtime.toISOString(),
          sha256: digest,
          verified: digest.length === 64,
          mediaArchived: false
        });
      } catch {
        /* ignore */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Verify a stored backup: checksum + integrity_check. */
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
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /**
   * Restore a backup over the live database file.
   * The current file is preserved as `.pre-restore-*` so a bad restore is
   * itself recoverable.
   */
  async restore(name: string): Promise<{ restored: string; preservedAs: string | null }> {
    const full = path.join(this.opts.backupDir, path.basename(name));
    const check = await this.verify(path.basename(name));
    if (!check.ok) throw new Error(`refusing to restore invalid backup: ${check.detail}`);

    // Capture the pre-restore high-water marks. The restored snapshot is older,
    // so its counters are lower; they are lifted back afterwards to keep
    // sequence numbers monotonic for clients that are still connected.
    const before = this.opts.readCounters?.() ?? { messageSeq: 0, eventSeq: 0 };

    // 1. Close the live connection so no WAL can be replayed over the copy.
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
      for (const suffix of ['-wal', '-shm']) {
        await fsp.rm(`${this.opts.dbFile}${suffix}`, { force: true });
      }
      await fsp.copyFile(full, this.opts.dbFile);
      this.opts.reopenAfterRestore?.();
      reopened = true;
      // 2. Lift the restored counters above the pre-restore watermark.
      this.opts.afterRestore?.(before);
      this.opts.onLog?.('warn', 'database restored from backup', { name });
      return { restored: full, preservedAs };
    } finally {
      // Never leave the app without a database connection.
      if (!reopened) this.opts.reopenAfterRestore?.();
    }
  }

  private async applyRetention(): Promise<void> {
    const all = await this.list();
    const extra = all.slice(this.opts.keep);
    for (const b of extra) {
      await fsp.rm(b.path, { force: true });
      await fsp.rm(`${b.path}.json`, { force: true });
      await fsp.rm(`${b.path}.sha256`, { force: true });
    }
  }
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      else count++;
    }
  }
  return count;
}
