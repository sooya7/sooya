import path from 'node:path';
import type { InputPart } from '../../core/types.js';
import type { MediaStore } from '../../media/store.js';
import type { QqAttachment } from './types.js';
import { draftMime, textExtension } from '../../core/files/drafts.js';

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

function isVoiceOrVideo(att: QqAttachment): boolean {
  const type = att.content_type?.toLowerCase().trim() ?? '';
  return type === 'voice' || type.startsWith('audio/') || type === 'video' || type.startsWith('video/') || Boolean(att.voice_wav_url);
}

/**
 * A file the user sent (document, script, text…). Saved as a `file` media row
 * under its own name; the caller queues text extraction and registers it as
 * a named file so she can read and edit it.
 */
export async function downloadQqFileAttachment(att: QqAttachment, deps: QqInboundMediaDeps): Promise<(InputPart & { type: 'file' }) & { filename?: string } | null> {
  if (isImage(att) || isVoiceOrVideo(att)) return null;
  const url = normalizeUrl(att.url);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('qq attachment download timeout')), 20_000);
  try {
    const response = await deps.fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`qq attachment download status ${response.status}`);
    const data = await readCapped(response, deps.maxBytes);
    const filename = att.filename?.trim() || undefined;
    const declared = att.content_type && att.content_type.includes('/') ? att.content_type : undefined;
    const media = await deps.mediaStore.save({
      kind: 'file', origin: 'remote', data,
      declaredMime: filename && textExtension(filename) ? draftMime(filename) : declared,
      filename, maxBytes: deps.maxBytes,
      meta: { source: 'qq', remoteUrlHost: new URL(url).hostname }
    });
    return { type: 'file', mediaId: media.id, ...(filename ? { filename } : {}) };
  } finally {
    clearTimeout(timer);
  }
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
