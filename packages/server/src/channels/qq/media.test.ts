import { describe, it, expect } from 'vitest';
import { classifyQqMedia, mediaSizeLimit, QQ_MEDIA_SIZE_LIMITS, type QqMediaClassify } from './media.js';

function row(overrides: Partial<{ kind: 'image' | 'audio' | 'sticker' | 'file'; mime: string; bytes: number }> = {}) {
  return {
    id: 'm1',
    kind: overrides.kind ?? 'image',
    rel_path: 'x',
    mime: overrides.mime ?? 'image/png',
    bytes: overrides.bytes ?? 1024,
    sha256: 's',
    width: null,
    height: null,
    duration: null,
    origin: 'upload' as const,
    created_at: 't',
    transcript: null,
    meta_json: '{}',
    tags_json: '[]',
    animated: 0,
    deleted_at: null,
    favorite: 0
  };
}

describe('qq media classification', () => {
  it('maps images to file_type 1 with supported formats', () => {
    expect(classifyQqMedia(row({ mime: 'image/png' }))).toMatchObject({ fileType: 1, supported: true });
    expect(classifyQqMedia(row({ mime: 'image/jpeg' }))).toMatchObject({ fileType: 1, supported: true });
    expect(classifyQqMedia(row({ mime: 'image/gif' }))).toMatchObject({ fileType: 1, supported: true });
  });

  it('marks webp/avif images as convertible', () => {
    for (const mime of ['image/webp', 'image/avif']) {
      const classify = classifyQqMedia(row({ mime })) as QqMediaClassify & { reason?: string };
      expect(classify.fileType).toBe(1);
      expect(classify.supported).toBe(true);
      expect(classify.reason).toBe('convert');
    }
  });

  it('rejects unsupported image mimes', () => {
    expect(classifyQqMedia(row({ mime: 'image/bmp' })).supported).toBe(false);
  });

  it('treats stickers as images (webp needs conversion)', () => {
    expect(classifyQqMedia(row({ kind: 'sticker', mime: 'image/png' }))).toMatchObject({ fileType: 1, supported: true });
    expect(classifyQqMedia(row({ kind: 'sticker', mime: 'image/webp' }))).toMatchObject({ fileType: 1, supported: true, reason: 'convert' });
  });

  it('maps supported audio to file_type 3', () => {
    for (const mime of ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/x-flac', 'audio/silk']) {
      expect(classifyQqMedia(row({ kind: 'audio', mime }))).toMatchObject({ fileType: 3, supported: true });
    }
  });

  it('rejects audio formats QQ does not accept', () => {
    expect(classifyQqMedia(row({ kind: 'audio', mime: 'audio/ogg' })).supported).toBe(false);
    expect(classifyQqMedia(row({ kind: 'audio', mime: 'audio/opus' })).supported).toBe(false);
  });

  it('maps files to file_type 4', () => {
    expect(classifyQqMedia(row({ kind: 'file', mime: 'application/pdf' }))).toMatchObject({ fileType: 4, supported: true });
  });

  it('enforces per-type size limits', () => {
    expect(mediaSizeLimit(1)).toBe(QQ_MEDIA_SIZE_LIMITS.image);
    expect(mediaSizeLimit(3)).toBe(QQ_MEDIA_SIZE_LIMITS.audio);
    expect(mediaSizeLimit(4)).toBe(QQ_MEDIA_SIZE_LIMITS.file);
  });
});