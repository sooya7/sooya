import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppEnv } from '../config/env.js';
import type { ConfigStore } from '../config/store.js';
import type { MediaRepo } from '../db/repos/media.repo.js';
import type { SettingsRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { AuditRepo, StorageSampleRepo } from '../db/repos/feature.repo.js';
import type { MediaStore } from '../media/store.js';
import type { MaintenanceCoordinator } from './maintenance.js';
import { dirSize } from '../util/fsx.js';

export interface StoragePolicy {
  softLimitBytes: number;
  hardLimitBytes: number;
  trashRetentionDays: number;
  tempRetentionHours: number;
  backupKeep: number;
}

export interface CleanupReport {
  generatedAt: string;
  candidates: {
    expiredTrash: Array<{ id: string; bytes: number; references: number }>;
    missingRecords: Array<{ id: string; relPath: string; bytes: number }>;
    orphanFiles: Array<{ path: string; bytes: number }>;
    unreferencedMedia: Array<{ id: string; bytes: number }>;
    tempFiles: Array<{ path: string; bytes: number }>;
    oldBackups: Array<{ path: string; bytes: number }>;
  };
  reclaimableBytes: number;
}

const DEFAULT_POLICY: StoragePolicy = {
  softLimitBytes: 700 * 1024 * 1024,
  hardLimitBytes: 950 * 1024 * 1024,
  trashRetentionDays: 30,
  tempRetentionHours: 24,
  backupKeep: 7
};

export class StorageService {
  private maintenanceRunning = false;
  private activeWrites = 0;

  constructor(
    private readonly env: AppEnv,
    private readonly media: MediaRepo,
    private readonly mediaStore: MediaStore,
    private readonly settings: SettingsRepo,
    private readonly audit: AuditRepo,
    private readonly samples: StorageSampleRepo,
    private readonly config: ConfigStore,
    private readonly errors: ErrorLogRepo,
    private readonly maintenance: MaintenanceCoordinator
  ) {
    const originalSave = mediaStore.save.bind(mediaStore);
    mediaStore.save = async (input) => {
      if (this.maintenance.isWriteBlocked()) {
        const current = this.maintenance.state();
        const error = new Error(`maintenance operation ${current?.operation ?? 'unknown'} is running; media writes are temporarily paused`) as Error & { code?: string };
        error.code = 'STORAGE_MAINTENANCE';
        throw error;
      }
      this.activeWrites++;
      try {
        await this.assertWritable(input.data.byteLength);
        return await originalSave(input);
      } finally {
        this.activeWrites--;
      }
    };
  }

  policy(): StoragePolicy {
    return normalizePolicy(this.settings.get<Partial<StoragePolicy>>('storage.policy', DEFAULT_POLICY));
  }

  setPolicy(patch: Partial<StoragePolicy>): StoragePolicy {
    const next = normalizePolicy({ ...this.policy(), ...patch });
    this.settings.set('storage.policy', next);
    this.audit.add('storage', 'policy.updated', null, next as unknown as Record<string, unknown>);
    return next;
  }

  async status(): Promise<Record<string, unknown>> {
    const [mediaBytes, dataBytes, backupBytes] = await Promise.all([
      dirSize(this.env.mediaDir),
      dirSize(this.env.dataDir),
      dirSize(this.env.backupDir)
    ]);
    let freeBytes: number | null = null;
    let totalBytes: number | null = null;
    try {
      const stat = await fsp.statfs(this.env.dataDir);
      freeBytes = Number(stat.bavail) * Number(stat.bsize);
      totalBytes = Number(stat.blocks) * Number(stat.bsize);
    } catch {
      /* unsupported filesystem */
    }
    const categories: Record<string, number> = { image: 0, audio: 0, sticker: 0, file: 0, trash: 0, backup: backupBytes };
    for (const row of this.media.allRows()) {
      categories[row.kind] = (categories[row.kind] ?? 0) + row.bytes;
      if (row.deleted_at) categories.trash = (categories.trash ?? 0) + row.bytes;
    }
    this.samples.add(mediaBytes, dataBytes, freeBytes);
    const policy = this.policy();
    return {
      mediaBytes,
      dataBytes,
      backupBytes,
      freeBytes,
      totalBytes,
      categories,
      policy,
      warning: mediaBytes >= policy.hardLimitBytes ? 'hard' : mediaBytes >= policy.softLimitBytes ? 'soft' : null,
      maintenanceRunning: this.maintenanceRunning,
      maintenance: this.maintenance.state(),
      activeWrites: this.activeWrites,
      trend: this.samples.list(48)
    };
  }

  async assertWritable(incomingBytes: number): Promise<void> {
    const policy = this.policy();
    const mediaBytes = await dirSize(this.env.mediaDir);
    if (mediaBytes + Math.max(0, incomingBytes) <= policy.hardLimitBytes) return;
    const error = new Error('storage hard limit reached; media upload is temporarily disabled') as Error & { code?: string };
    error.code = 'STORAGE_HARD_LIMIT';
    throw error;
  }

  async report(): Promise<CleanupReport> {
    const policy = this.policy();
    const rows = this.media.allRows();
    const avatarIds = this.avatarMediaIds();
    const expiredCutoff = new Date(Date.now() - policy.trashRetentionDays * 86400_000).toISOString();
    const expiredTrash = this.media.listExpiredTrash(expiredCutoff, 1000).map((row) => ({
      id: row.id,
      bytes: row.bytes,
      references: this.media.references(row.id).total + (avatarIds.has(row.id) ? 1 : 0)
    }));
    const missingRecords = rows.filter((row) => !this.mediaStore.exists(row)).map((row) => ({ id: row.id, relPath: row.rel_path, bytes: row.bytes }));
    const knownPaths = new Set<string>();
    for (const row of rows) {
      try {
        const located = this.mediaStore.streamPath(row.id);
        if (located) knownPaths.add(path.resolve(located.path));
      } catch {
        /* malformed database path is reported as missing */
      }
    }
    const allMediaFiles = await walkFiles(this.env.mediaDir);
    const tempRoot = path.resolve(this.env.mediaDirs.tmp);
    const orphanFiles = allMediaFiles.filter((file) => {
      const resolved = path.resolve(file.path);
      return !knownPaths.has(resolved) && !resolved.startsWith(`${tempRoot}${path.sep}`);
    });
    const unreferencedMedia = this.media.listUnreferenced(1000)
      .filter((row) => !avatarIds.has(row.id))
      .map((row) => ({ id: row.id, bytes: row.bytes }));
    const tempCutoff = Date.now() - policy.tempRetentionHours * 3600_000;
    const tempFiles = (await walkFiles(this.env.mediaDirs.tmp)).filter((file) => file.mtimeMs < tempCutoff);
    const backupFiles = (await walkFiles(this.env.backupDir)).filter((file) => /\.(db|sqlite|tar\.gz)(\.sha256|\.json)?$/i.test(file.path));
    const groups = new Map<string, Array<{ path: string; bytes: number; mtimeMs: number }>>();
    for (const file of backupFiles) {
      const key = file.path.replace(/\.(sha256|json)$/i, '');
      const group = groups.get(key) ?? [];
      group.push(file);
      groups.set(key, group);
    }
    const oldBackups = [...groups.entries()]
      .map(([key, files]) => ({ key, files, mtime: Math.max(...files.map((file) => file.mtimeMs)) }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(policy.backupKeep)
      .flatMap((group) => group.files.map((file) => ({ path: file.path, bytes: file.bytes })));
    const reclaimableBytes = [
      ...expiredTrash.filter((item) => item.references === 0),
      ...orphanFiles,
      ...unreferencedMedia,
      ...tempFiles,
      ...oldBackups
    ].reduce((sum, item) => sum + item.bytes, 0);
    return {
      generatedAt: new Date().toISOString(),
      candidates: { expiredTrash, missingRecords, orphanFiles, unreferencedMedia, tempFiles, oldBackups },
      reclaimableBytes
    };
  }

  async cleanup(input: { apply?: boolean; categories?: string[] } = {}): Promise<{ applied: boolean; report: CleanupReport; deleted: Record<string, number>; releasedBytes: number }> {
    if (this.activeWrites > 0) throw new Error('media write is in progress; retry cleanup shortly');
    const release = this.maintenance.begin('storage.cleanup', { blocksWrites: true });
    this.maintenanceRunning = true;
    try {
      const report = await this.report();
      const categories = new Set(input.categories ?? ['expiredTrash', 'orphanFiles', 'unreferencedMedia', 'tempFiles', 'oldBackups', 'missingRecords']);
      const deleted: Record<string, number> = {};
      let releasedBytes = 0;
      if (!input.apply) return { applied: false, report, deleted, releasedBytes };

      if (categories.has('expiredTrash')) {
        for (const item of report.candidates.expiredTrash) {
          if (item.references > 0) continue;
          if (await this.mediaStore.delete(item.id)) {
            deleted.expiredTrash = (deleted.expiredTrash ?? 0) + 1;
            releasedBytes += item.bytes;
          }
        }
      }
      if (categories.has('unreferencedMedia')) {
        for (const item of report.candidates.unreferencedMedia) {
          const row = this.media.get(item.id);
          if (!row || !row.deleted_at || this.media.references(item.id).total > 0) continue;
          if (await this.mediaStore.delete(item.id)) {
            deleted.unreferencedMedia = (deleted.unreferencedMedia ?? 0) + 1;
            releasedBytes += item.bytes;
          }
        }
      }
      for (const category of ['orphanFiles', 'tempFiles', 'oldBackups'] as const) {
        if (!categories.has(category)) continue;
        for (const item of report.candidates[category]) {
          await fsp.rm(item.path, { force: true });
          deleted[category] = (deleted[category] ?? 0) + 1;
          releasedBytes += item.bytes;
        }
      }
      if (categories.has('missingRecords')) {
        for (const item of report.candidates.missingRecords) {
          if (this.media.references(item.id).total > 0 || this.avatarMediaIds().has(item.id)) continue;
          if (this.media.delete(item.id)) deleted.missingRecords = (deleted.missingRecords ?? 0) + 1;
        }
      }
      this.audit.add('storage', 'cleanup.applied', null, { deleted, releasedBytes, generatedAt: report.generatedAt });
      return { applied: true, report, deleted, releasedBytes };
    } catch (error) {
      this.errors.add('storage.cleanup', (error as Error).message);
      throw error;
    } finally {
      this.maintenanceRunning = false;
      release();
    }
  }

  isAvatarMedia(id: string): boolean {
    return this.avatarMediaIds().has(id);
  }

  private avatarMediaIds(): Set<string> {
    const persona = this.config.getPersona();
    return new Set([mediaIdFromUrl(persona.avatar), mediaIdFromUrl(persona.userAvatar)].filter(Boolean) as string[]);
  }
}

function normalizePolicy(input: Partial<StoragePolicy>): StoragePolicy {
  const soft = clampInt(input.softLimitBytes, 64 * 1024 * 1024, 20 * 1024 * 1024 * 1024, DEFAULT_POLICY.softLimitBytes);
  const hard = Math.max(soft + 16 * 1024 * 1024, clampInt(input.hardLimitBytes, 80 * 1024 * 1024, 24 * 1024 * 1024 * 1024, DEFAULT_POLICY.hardLimitBytes));
  return {
    softLimitBytes: soft,
    hardLimitBytes: hard,
    trashRetentionDays: clampInt(input.trashRetentionDays, 1, 3650, DEFAULT_POLICY.trashRetentionDays),
    tempRetentionHours: clampInt(input.tempRetentionHours, 1, 24 * 365, DEFAULT_POLICY.tempRetentionHours),
    backupKeep: clampInt(input.backupKeep, 1, 100, DEFAULT_POLICY.backupKeep)
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function mediaIdFromUrl(url: string): string | null {
  const match = /\/api\/media\/([A-Za-z0-9_-]+)/.exec(url);
  return match?.[1] ?? null;
}

async function walkFiles(root: string): Promise<Array<{ path: string; bytes: number; mtimeMs: number }>> {
  if (!fs.existsSync(root)) return [];
  const out: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full);
          out.push({ path: full, bytes: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          /* raced with cleanup */
        }
      }
    }
  }
  return out;
}
