import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import type { MediaRepo, MediaRow } from '../db/repos/media.repo.js';
import { atomicWriteFile, ensureDirSync, safeJoin } from '../util/fsx.js';
import { newMediaId, sha256 } from '../util/ids.js';
import { probeAudioDuration } from '../util/audio.js';

export interface MediaDirs {
  images: string;
  audio: string;
  stickers: string;
  files: string;
  tmp: string;
}

export const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);
export const ALLOWED_AUDIO_MIME = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/aac',
  'audio/flac',
  'video/webm'
]);
export const ALLOWED_FILE_MIME = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);

export class MediaValidationError extends Error {
  override name = 'MediaValidationError';
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
  }
}

export interface SaveOptions {
  kind: MediaRow['kind'];
  origin: MediaRow['origin'];
  data: Buffer;
  declaredMime?: string;
  filename?: string;
  durationHint?: number | null;
  transcript?: string | null;
  meta?: Record<string, unknown>;
  maxBytes?: number;
  allowUnknownType?: boolean;
}

export class MediaStore {
  constructor(
    private readonly dirs: MediaDirs,
    private readonly repo: MediaRepo,
    private readonly limits: { maxUploadBytes: number }
  ) {
    for (const dir of Object.values(dirs)) ensureDirSync(dir);
  }

  dirFor(kind: MediaRow['kind']): string {
    switch (kind) {
      case 'image':
        return this.dirs.images;
      case 'audio':
        return this.dirs.audio;
      case 'sticker':
        return this.dirs.stickers;
      default:
        return this.dirs.files;
    }
  }

  absolutePath(row: MediaRow): string {
    return safeJoin(this.dirFor(row.kind), row.rel_path);
  }

  async save(opts: SaveOptions): Promise<MediaRow> {
    const maxBytes = opts.maxBytes ?? this.limits.maxUploadBytes;
    if (opts.data.byteLength === 0) throw new MediaValidationError('empty file', 'EMPTY');
    if (opts.data.byteLength > maxBytes) {
      throw new MediaValidationError(`file too large: ${opts.data.byteLength} > ${maxBytes}`, 'TOO_LARGE');
    }

    const sniffed = await fileTypeFromBuffer(opts.data);
    const mime = await this.resolveMime(opts, sniffed?.mime);
    const ext = sniffed?.ext ?? extFromMime(mime) ?? extFromName(opts.filename) ?? 'bin';

    const id = newMediaId();
    const digest = sha256(opts.data);
    const relPath = `${id}.${ext}`;
    const target = safeJoin(this.dirFor(opts.kind), relPath);
    await atomicWriteFile(target, opts.data);

    let duration: number | null = null;
    if (opts.kind === 'audio') {
      duration = probeAudioDuration(opts.data, mime);
      if (duration === null && typeof opts.durationHint === 'number' && opts.durationHint > 0) {
        duration = Math.round(opts.durationHint * 100) / 100;
      }
    }
    const dims = opts.kind === 'image' || opts.kind === 'sticker' ? probeImageSize(opts.data) : null;

    try {
      return this.repo.create({
        id,
        kind: opts.kind,
        relPath,
        mime,
        bytes: opts.data.byteLength,
        sha256: digest,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        duration,
        origin: opts.origin,
        transcript: opts.transcript ?? null,
        meta: { ...(opts.meta ?? {}), name: opts.filename ?? null, durationSource: duration === null ? 'unknown' : 'probe' }
      });
    } catch (err) {
      await fsp.rm(target, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async resolveMime(opts: SaveOptions, sniffedMime: string | undefined): Promise<string> {
    const declared = (opts.declaredMime ?? '').split(';')[0]?.trim().toLowerCase() || '';
    const effective = sniffedMime ?? declared;
    const allowed = this.allowedFor(opts.kind);

    if (opts.kind === 'image' || opts.kind === 'sticker') {
      if (!sniffedMime) throw new MediaValidationError('could not determine image type from content', 'UNKNOWN_TYPE');
      if (!allowed.has(sniffedMime)) throw new MediaValidationError(`image type not allowed: ${sniffedMime}`, 'TYPE_NOT_ALLOWED');
      return sniffedMime;
    }
    if (opts.kind === 'audio') {
      const candidate = sniffedMime ?? declared;
      if (!candidate) throw new MediaValidationError('could not determine audio type', 'UNKNOWN_TYPE');
      if (!allowed.has(candidate)) throw new MediaValidationError(`audio type not allowed: ${candidate}`, 'TYPE_NOT_ALLOWED');
      return candidate === 'video/webm' ? 'audio/webm' : candidate;
    }
    if (!sniffedMime) {
      if (isProbablyText(opts.data)) return declared && ALLOWED_FILE_MIME.has(declared) ? declared : 'text/plain';
      if (opts.allowUnknownType) return 'application/octet-stream';
      throw new MediaValidationError('could not determine file type from content', 'UNKNOWN_TYPE');
    }
    if (!allowed.has(sniffedMime)) throw new MediaValidationError(`file type not allowed: ${sniffedMime}`, 'TYPE_NOT_ALLOWED');
    return effective;
  }

  private allowedFor(kind: MediaRow['kind']): Set<string> {
    if (kind === 'image' || kind === 'sticker') return ALLOWED_IMAGE_MIME;
    if (kind === 'audio') return ALLOWED_AUDIO_MIME;
    return ALLOWED_FILE_MIME;
  }

  async read(id: string): Promise<{ row: MediaRow; data: Buffer } | null> {
    const row = this.repo.get(id);
    if (!row) return null;
    try {
      const data = await fsp.readFile(this.absolutePath(row));
      return { row, data };
    } catch {
      return null;
    }
  }

  exists(row: MediaRow): boolean {
    try {
      return fs.existsSync(this.absolutePath(row));
    } catch {
      return false;
    }
  }

  streamPath(id: string): { row: MediaRow; path: string } | null {
    const row = this.repo.get(id);
    if (!row) return null;
    const abs = this.absolutePath(row);
    if (!fs.existsSync(abs)) return null;
    return { row, path: abs };
  }

  async delete(id: string): Promise<boolean> {
    const row = this.repo.get(id);
    if (!row) return false;
    await fsp.rm(this.absolutePath(row), { force: true });
    if (!this.repo.delete(id)) throw new Error('media database record deletion failed');
    return true;
  }

  async collectOrphans(minAgeMs = 2 * 60 * 60 * 1000, protectedIds?: ReadonlySet<string>): Promise<string[]> {
    const cutoff = new Date(Date.now() - minAgeMs).toISOString();
    const rows = this.repo.listOrphanUploads(cutoff, 500);
    const removed: string[] = [];
    for (const row of rows) {
      if (protectedIds?.has(row.id)) continue;
      await fsp.rm(this.absolutePath(row), { force: true });
      if (!this.repo.delete(row.id)) throw new Error('orphan media database record deletion failed');
      removed.push(row.id);
    }
    return removed;
  }

  async reconcile(): Promise<string[]> {
    const removed: string[] = [];
    const all = this.repo.list(10_000, 0);
    for (const row of all) {
      if (!this.exists(row)) removed.push(row.id);
    }
    return removed;
  }
}

function extFromMime(mime: string): string | null {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/flac': 'flac',
    'text/plain': 'txt',
    'application/json': 'json',
    'application/pdf': 'pdf'
  };
  return map[mime] ?? null;
}

function extFromName(name?: string): string | null {
  if (!name) return null;
  const ext = path.extname(name).replace('.', '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null;
}

function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.byteLength, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / Math.max(sample.byteLength, 1) < 0.05;
}

export function probeImageSize(buf: Buffer): { width: number; height: number } | null {
  try {
    if (buf.byteLength > 24 && buf.subarray(1, 4).toString('latin1') === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.subarray(0, 3).toString('latin1') === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.byteLength) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1]!;
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
      const fmt = buf.subarray(12, 16).toString('latin1');
      if (fmt === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    return null;
  }
  return null;
}
