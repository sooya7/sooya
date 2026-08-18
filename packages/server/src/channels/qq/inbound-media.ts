import path from 'node:path';
import type { InputPart } from '../../core/types.js';
import type { MediaStore } from '../../media/store.js';
import type { QqAttachment } from './types.js';

const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.avif']);

export interface QqInboundMediaDeps {
  mediaStore: MediaStore;
  fetchImpl: typeof fetch;
  maxBytes: number;
}

function normalizeUrl(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const normalized = value.startsWith('//') ? `https:${value}` : value;
  try {
    const url = new URL(normalized);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch { return null; }
}

function isImage(att: QqAttachment): boolean {
  const type = att.content_type?.toLowerCase().trim() ?? '';
  return type.startsWith('image/') || IMAGE_EXTS.has(path.extname(att.filename ?? '').toLowerCase());
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new Error(`qq attachment too large: ${declared} > ${maxBytes}`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`qq attachment too large: exceeded ${maxBytes}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function downloadQqImageAttachment(att: QqAttachment, deps: QqInboundMediaDeps): Promise<InputPart | null> {
  if (!isImage(att)) return null;
  const url = normalizeUrl(att.url);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('qq attachment download timeout')), 10_000);
  try {
    const response = await deps.fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`qq attachment download status ${response.status}`);
    const data = await readCapped(response, deps.maxBytes);
    const media = await deps.mediaStore.save({
      kind: 'image', origin: 'remote', data, declaredMime: att.content_type,
      filename: att.filename, maxBytes: deps.maxBytes,
      meta: { source: 'qq', remoteUrlHost: new URL(url).hostname }
    });
    return { type: 'image', mediaId: media.id };
  } finally {
    clearTimeout(timer);
  }
}
