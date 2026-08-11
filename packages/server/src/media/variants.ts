import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { MediaRow } from '../db/repos/media.repo.js';
import { atomicWriteFile, ensureDirSync } from '../util/fsx.js';

/*
 * 聊天气泡和画廊只显示几百像素宽，但 `GET /api/media/<id>` 只有原图一种响应，
 * 一张 2 MB 的生成图每次首屏都要整张下载完才成像。这里按宽度生成 WebP 变体并
 * 落盘复用：同一个 id 的字节永不改写，所以变体也可以一直留在磁盘上。
 *
 * 宽度只接受固定档位（请求值向上取档），否则任何人都能用 `?w=` 逐像素刷出
 * 上千个文件把磁盘填满。
 */
export const VARIANT_WIDTHS = [240, 480, 960] as const;
export const VARIANT_MIME = 'image/webp';
const VARIANT_QUALITY = 78;

/** sharp 能解码且值得缩放的类型。GIF 可能是动图，缩放会丢掉动画；BMP 无解码器。 */
const RESIZABLE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

/** 把请求宽度归一到档位；无效、缺失或超过最大档位时返回 null，调用方回退原图。 */
export function resolveVariantWidth(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]{0,4}$/.test(trimmed)) return null;
  const asked = Number(trimmed);
  return VARIANT_WIDTHS.find((width) => width >= asked) ?? null;
}

export function variantPath(dir: string, id: string, width: number): string {
  return path.join(dir, `${id}-w${width}.webp`);
}

/** 删除某个 id 的全部变体。媒体被删除或被孤儿回收时调用，避免留下无主缓存。 */
export async function removeVariants(dir: string, id: string): Promise<void> {
  for (const width of VARIANT_WIDTHS) {
    await fsp.rm(variantPath(dir, id, width), { force: true }).catch(() => undefined);
  }
}

export interface VariantFile {
  path: string;
  mime: string;
  width: number;
  bytes: number;
}

export class ImageVariantService {
  /** 同一变体的并发请求共用一次渲染，避免 CPU 峰值和重复写盘。 */
  private readonly inflight = new Map<string, Promise<VariantFile | null>>();

  constructor(
    private readonly dir: string,
    private readonly onError?: (message: string, id: string) => void
  ) {
    ensureDirSync(dir);
  }

  /** 返回缓存或新生成的变体；不适用（非图片、无法解码、原图本来就更小）时返回 null。 */
  async get(row: MediaRow, sourcePath: string, width: number): Promise<VariantFile | null> {
    if (row.kind !== 'image' && row.kind !== 'sticker') return null;
    if (!RESIZABLE_MIME.has(row.mime)) return null;
    if (row.width !== null && row.width <= width) return null;
    // Resizing an animated WebP with a normal sharp pipeline silently keeps
    // only one frame. New rows carry the flag; the metadata probe preserves
    // animation for rows created before that column existed.
    if (row.animated === 1 || await isAnimatedWebp(sourcePath, row.mime)) return null;

    const target = variantPath(this.dir, row.id, width);
    const cached = sizeOf(target);
    if (cached > 0) return { path: target, mime: VARIANT_MIME, width, bytes: cached };

    const key = `${row.id}:${width}`;
    const pending =
      this.inflight.get(key) ??
      this.render(row.id, sourcePath, target, width).finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, pending);
    return pending;
  }

  private async render(id: string, sourcePath: string, target: string, width: number): Promise<VariantFile | null> {
    try {
      const out = await sharp(sourcePath, { failOn: 'none' })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: VARIANT_QUALITY })
        .toBuffer();
      await atomicWriteFile(target, out);
      return { path: target, mime: VARIANT_MIME, width, bytes: out.byteLength };
    } catch (err) {
      // 解码失败不应该让图片打不开：记录后回退原图。
      this.onError?.((err as Error).message, id);
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    await removeVariants(this.dir, id);
  }
}

async function isAnimatedWebp(sourcePath: string, mime: string): Promise<boolean> {
  if (mime !== 'image/webp') return false;
  try {
    const metadata = await sharp(sourcePath, { animated: true, failOn: 'none' }).metadata();
    return (metadata.pages ?? 1) > 1;
  } catch {
    return false;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
