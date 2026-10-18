/**
 * Files she writes for the user (and files the user sends her), by name.
 *
 * - `file_write` / `file_edit` run inside the reply's tool round. They only
 *   stage the new text in memory, keyed by batch + revision: a generation that
 *   gets superseded leaves nothing behind. `publish` turns what was staged
 *   into a file part of the published reply, which QQ delivery sends.
 * - Only the latest version of a name is kept (the previous media row is
 *   removed when a new one lands), and only until `retentionMs` passes with no
 *   change. Then the file is gone for good.
 */
import path from 'node:path';
import type { FileDraftRepo, FileDraftRow } from '../../db/repos/file-draft.repo.js';
import type { MediaStore } from '../../media/store.js';
import type { MediaRepo } from '../../db/repos/media.repo.js';
import type { ErrorLogRepo } from '../../db/repos/misc.repo.js';

export const DEFAULT_FILE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
/** Upper bound for one file she writes (also the tool-argument cap for file_write / file_edit). */
export const MAX_DRAFT_BYTES = 256 * 1024;

/** Text formats she may write; the extension also decides the MIME QQ sees. */
const TEXT_EXTENSIONS: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.py': 'text/plain', '.sh': 'text/plain', '.bash': 'text/plain', '.zsh': 'text/plain',
  '.js': 'text/plain', '.mjs': 'text/plain', '.cjs': 'text/plain', '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain',
  '.html': 'text/plain', '.css': 'text/plain', '.sql': 'text/plain',
  '.yaml': 'text/plain', '.yml': 'text/plain', '.toml': 'text/plain', '.ini': 'text/plain', '.conf': 'text/plain', '.env.example': 'text/plain',
  '.ps1': 'text/plain', '.bat': 'text/plain', '.cmd': 'text/plain',
  '.java': 'text/plain', '.kt': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain', '.c': 'text/plain', '.h': 'text/plain',
  '.cpp': 'text/plain', '.cs': 'text/plain', '.php': 'text/plain', '.rb': 'text/plain', '.lua': 'text/plain', '.swift': 'text/plain',
  '.xml': 'text/plain', '.svg': 'text/plain', '.tex': 'text/plain', '.srt': 'text/plain', '.log': 'text/plain'
};

export function textExtension(name: string): string | null {
  const lower = name.toLowerCase();
  for (const ext of Object.keys(TEXT_EXTENSIONS)) if (lower.endsWith(ext)) return ext;
  return null;
}

/** A safe bare file name ("周报.md"), or an error message she can act on. */
export function normalizeDraftName(raw: unknown, opts: { requireText: boolean }): { name: string } | { error: string } {
  const base = path.basename(String(raw ?? '').replace(/\\/g, '/').trim());
  if (!base || base === '.' || base === '..') return { error: '文件名不能为空' };
  if (base.length > 80) return { error: '文件名太长了（最多 80 个字符）' };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()（）\-]*$/u.test(base)) return { error: '文件名只能用文字、数字、空格和 . _ - ( )' };
  if (opts.requireText && !textExtension(base)) {
    return { error: `不支持这种文件类型，请用文本格式的扩展名，比如 .md .txt .py .sh .js .json .csv` };
  }
  return { name: base };
}

export function draftMime(name: string): string {
  const ext = textExtension(name);
  return ext ? TEXT_EXTENSIONS[ext]! : 'text/plain';
}

export interface FileDraftDeps {
  repo: FileDraftRepo;
  mediaStore: MediaStore;
  mediaRepo: MediaRepo;
  errors?: ErrorLogRepo;
  retentionMs?: number;
  now?: () => number;
}

interface StagedFile {
  content: string;
  saveToKnowledge: boolean;
}

interface Stage {
  files: Map<string, StagedFile>;
  createdAt: number;
}

export interface PublishedFile {
  name: string;
  mediaId: string;
  saveToKnowledge: boolean;
}

export class FileDraftService {
  private readonly stages = new Map<string, Stage>();
  readonly retentionMs: number;

  constructor(private readonly deps: FileDraftDeps) {
    this.retentionMs = deps.retentionMs ?? DEFAULT_FILE_RETENTION_MS;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private stage(batchId: string, revision: number, create: boolean): Stage | undefined {
    const key = `${batchId}:${revision}`;
    let stage = this.stages.get(key);
    if (!stage && create) {
      this.pruneStages();
      stage = { files: new Map(), createdAt: this.now() };
      this.stages.set(key, stage);
    }
    return stage;
  }

  /** Staged generations that never published (superseded, failed) are forgotten after an hour. */
  private pruneStages(): void {
    const cutoff = this.now() - 60 * 60 * 1000;
    for (const [key, stage] of this.stages) if (stage.createdAt < cutoff) this.stages.delete(key);
  }

  /** Latest stored text of a name, or null (unknown, expired, or not a text file). */
  async storedText(name: string): Promise<{ text: string; row: FileDraftRow } | null> {
    const row = this.deps.repo.get(name);
    if (!row || !this.isLive(row)) return null;
    const read = await this.deps.mediaStore.read(row.media_id);
    if (!read) return null;
    return { text: read.data.toString('utf8'), row };
  }

  private isLive(row: FileDraftRow): boolean {
    return Date.parse(row.updated_at) >= this.now() - this.retentionMs;
  }

  /** What she sees: the staged version in this reply if any, else the stored one. */
  async currentText(name: string, ctx: { batchId?: string; revision?: number }): Promise<string | null> {
    if (ctx.batchId !== undefined && ctx.revision !== undefined) {
      const staged = this.stage(ctx.batchId, ctx.revision, false)?.files.get(name);
      if (staged) return staged.content;
    }
    const stored = await this.storedText(name);
    if (!stored) return null;
    return stored.row.editable === 1 ? stored.text : null;
  }

  listLive(): Array<{ name: string; origin: FileDraftRow['origin']; editable: boolean; updatedAt: string; expiresAt: string }> {
    return this.deps.repo.list(50).filter((row) => this.isLive(row)).map((row) => ({
      name: row.name,
      origin: row.origin,
      editable: row.editable === 1,
      updatedAt: row.updated_at,
      expiresAt: new Date(Date.parse(row.updated_at) + this.retentionMs).toISOString()
    }));
  }

  stageWrite(name: string, content: string, ctx: { batchId?: string; revision?: number }, saveToKnowledge: boolean): void {
    if (ctx.batchId === undefined || ctx.revision === undefined) throw new Error('file tools only work while replying');
    const stage = this.stage(ctx.batchId, ctx.revision, true)!;
    const previous = stage.files.get(name);
    stage.files.set(name, { content, saveToKnowledge: saveToKnowledge || previous?.saveToKnowledge === true });
  }

  /**
   * Publishes what this generation staged: each file becomes a media row and
   * replaces the previous version of its name. Returns the published files in
   * the order they were written; the caller attaches them to the reply.
   */
  async publish(batchId: string, revision: number): Promise<PublishedFile[]> {
    const key = `${batchId}:${revision}`;
    const stage = this.stages.get(key);
    this.stages.delete(key);
    if (!stage || stage.files.size === 0) return [];
    const published: PublishedFile[] = [];
    for (const [name, file] of stage.files) {
      const media = await this.deps.mediaStore.save({
        kind: 'file',
        origin: 'generated',
        data: Buffer.from(file.content, 'utf8'),
        declaredMime: draftMime(name),
        filename: name,
        maxBytes: MAX_DRAFT_BYTES * 2,
        meta: { draft: true }
      });
      const replaced = this.deps.repo.upsert({ name, mediaId: media.id, origin: 'written', editable: true });
      if (replaced) await this.removeMedia(replaced);
      published.push({ name, mediaId: media.id, saveToKnowledge: file.saveToKnowledge });
    }
    return published;
  }

  /** A file the user sent: it becomes the latest version of its name, under the same retention. */
  async registerReceived(mediaId: string, rawName: string | undefined): Promise<string | null> {
    const media = this.deps.mediaRepo.get(mediaId);
    if (!media) return null;
    const normalized = normalizeDraftName(rawName || `文件-${mediaId.slice(-6)}`, { requireText: false });
    const name = 'name' in normalized ? normalized.name : `文件-${mediaId.slice(-6)}`;
    const editable = Boolean(textExtension(name)) && (media.mime.startsWith('text/') || media.mime === 'application/json');
    const replaced = this.deps.repo.upsert({ name, mediaId, origin: 'received', editable });
    if (replaced) await this.removeMedia(replaced);
    return name;
  }

  /** Removes files whose retention passed. Returns the names removed. */
  async sweep(): Promise<string[]> {
    const cutoff = new Date(this.now() - this.retentionMs).toISOString();
    const removed: string[] = [];
    for (const row of this.deps.repo.expiredBefore(cutoff)) {
      await this.removeMedia(row.media_id);
      this.deps.repo.delete(row.name); // cascade usually did it already
      removed.push(row.name);
    }
    this.pruneStages();
    return removed;
  }

  private async removeMedia(mediaId: string): Promise<void> {
    try {
      await this.deps.mediaStore.delete(mediaId);
    } catch (error) {
      this.deps.errors?.add('files.remove', error instanceof Error ? error.message : String(error), { mediaId });
    }
  }
}
