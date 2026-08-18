import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseUserDirectives, stripModelDirectives, StreamingDirectiveFilter } from '../src/core/directives.js';
import { safeJoin, PathTraversalError, atomicWriteFileSync, cleanupTempFiles } from '../src/util/fsx.js';
import { isPrivateIp, assertSafeUrl, SsrfError, withRetry, defaultRetryable, HttpTimeoutError } from '../src/util/http.js';
import { redactSecrets, maskSecret, redactStringSecrets } from '../src/util/logger.js';
import { probeAudioDuration, buildWav, detectContainer } from '../src/util/audio.js';
import { probeImageSize } from '../src/media/store.js';
import { cosineSimilarity, normalizeMemoryText, floatsToBuffer, bufferToFloats } from '../src/db/repos/memory.repo.js';
import { parseCandidates } from '../src/core/memory.js';
import { guessEmotion } from '../src/core/replier.js';
import { makeFakeMp3, makeFakeWav, TEST_PNG } from './helpers/harness.js';

/** Tracked temp dirs, removed after the file so /tmp does not accumulate. */
const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('user directive parsing', () => {
  it('detects sticker requests', () => {
    expect(parseUserDirectives('发个表情').wantSticker).toBe(true);
    expect(parseUserDirectives('来个表情包吧').wantSticker).toBe(true);
    expect(parseUserDirectives('换一个表情').anotherSticker).toBe(true);
    expect(parseUserDirectives('只发表情').stickerOnly).toBe(true);
    expect(parseUserDirectives('不要发表情').noSticker).toBe(true);
    expect(parseUserDirectives('不要发表情').wantSticker).toBeUndefined();
  });

  it('detects voice requests', () => {
    expect(parseUserDirectives('用语音说').wantVoice).toBe(true);
    expect(parseUserDirectives('只发语音').voiceOnly).toBe(true);
    expect(parseUserDirectives('不要发语音').noVoice).toBe(true);
    expect(parseUserDirectives('不要发语音').wantVoice).toBeUndefined();
  });

  it('detects image requests and extracts the prompt', () => {
    const d = parseUserDirectives('生成一张图片，一只戴帽子的猫');
    expect(d.wantImage).toBe(true);
    expect(d.imagePrompt).toContain('猫');
  });

  it('detects photo/selfie phrasings so the fallback covers them too', () => {
    for (const t of ['来张自拍', '自拍一张', '拍一张', '拍一张给我看看', '发张照片', '给我看你的照片', '拍一张你的照片']) {
      const d = parseUserDirectives(t);
      expect(d.wantImage, t).toBe(true);
    }
    // 自拍类措辞要能识别出是要她本人的照片
    expect(parseUserDirectives('来张自拍').selfieIntent).toBe(true);
    expect(parseUserDirectives('拍一张你的照片').selfieIntent).toBe(true);
    // 普通要图不算自拍
    expect(parseUserDirectives('画一张猫').selfieIntent).toBeUndefined();
  });

  it('does not treat ordinary chat about photos as an image command', () => {
    expect(parseUserDirectives('我今天去拍照了，好累').wantImage).toBeUndefined();
    expect(parseUserDirectives('我拍你马屁').wantImage).toBeUndefined();
  });

  it('does not fire on unrelated text', () => {
    const d = parseUserDirectives('今天天气不错，我们去散步吧');
    expect(d.wantSticker).toBeUndefined();
    expect(d.wantVoice).toBeUndefined();
    expect(d.wantImage).toBeUndefined();
  });

  it('treats ability questions as questions, not commands', () => {
    for (const q of ['你会画画吗', '你会画画吗？', '你能画图吗', '可以生成图片吗', '你会不会画画', '会发语音吗', '你可以读出来吗', '能读出来吗', '你会自拍吗', '可以拍照吗']) {
      const d = parseUserDirectives(q);
      expect(d.wantImage, q).toBeUndefined();
      expect(d.wantVoice, q).toBeUndefined();
      expect(d.wantSticker, q).toBeUndefined();
    }
  });

  it('still fires on requests that mention a concrete subject', () => {
    // 带具体主题的祈使是请求，不是能力问题；guard 不得拦截。
    expect(parseUserDirectives('能画一张猫吗').wantImage).toBe(true);
    expect(parseUserDirectives('用语音说晚安').wantVoice).toBe(true);
    expect(parseUserDirectives('发个表情').wantSticker).toBe(true);
  });
});

describe('model directive markers', () => {
  it('strips markers and reports them', () => {
    const r = stripModelDirectives('我在呢。[[sticker:开心]] 要不要聊聊？[[voice]]');
    expect(r.text).not.toContain('[[');
    expect(r.text).toContain('我在呢');
    expect(r.directives.sticker).toBe('开心');
    expect(r.directives.voice).toBe(true);
  });

  it('handles voice-only and sticker-only', () => {
    expect(stripModelDirectives('晚安[[voice-only]]').directives.voiceOnly).toBe(true);
    expect(stripModelDirectives('[[sticker-only:难过]]').directives.stickerOnly).toBe(true);
    expect(stripModelDirectives('[[sticker-only:难过]]').text).toBe('');
  });

  it('strips a marker truncated by a broken stream', () => {
    // The stream died mid-marker; the raw text must never reach the user.
    expect(stripModelDirectives('你好呀[[sticker:开').text).toBe('你好呀');
    expect(stripModelDirectives('文档里提到 [[image:').text).toBe('文档里提到');
    expect(stripModelDirectives('结尾就是 [[').text).toBe('结尾就是');
    expect(stripModelDirectives('半个 [[voice-on').text).toBe('半个');
  });

  it('does not eat legitimate double brackets', () => {
    expect(stripModelDirectives('数组写法 arr[[0]] 是合法文本').text).toBe('数组写法 arr[[0]] 是合法文本');
    expect(stripModelDirectives('看这个 [[note]] 备注').text).toBe('看这个 [[note]] 备注');
    expect(stripModelDirectives('纯文本没有括号').text).toBe('纯文本没有括号');
  });

  it('never leaks a partial marker while streaming', () => {
    const filter = new StreamingDirectiveFilter();
    const chunks = ['你好', '呀', '[', '[stick', 'er:开心]', ']', '再见'];
    let out = '';
    for (const c of chunks) out += filter.push(c);
    out += filter.flush();
    expect(out).toBe('你好呀再见');
    expect(out).not.toContain('[');
  });

  it('drops an unterminated marker at flush', () => {
    const filter = new StreamingDirectiveFilter();
    let out = filter.push('hi [[stick');
    out += filter.flush();
    expect(out).toBe('hi ');
  });
});

describe('path traversal protection', () => {
  const root = makeTempDir('sooya-safe-');

  it('allows normal names', () => {
    expect(safeJoin(root, 'a.png')).toBe(path.join(root, 'a.png'));
    expect(safeJoin(root, 'sub/b.png')).toBe(path.join(root, 'sub/b.png'));
  });

  it('rejects traversal in many encodings', () => {
    const attacks = [
      '../secret',
      '../../etc/passwd',
      '..%2fsecret',
      '%2e%2e%2fsecret',
      '%252e%252e%252fsecret',
      '/etc/passwd',
      'sub/../../escape',
      'a\0b'
    ];
    for (const a of attacks) {
      expect(() => safeJoin(root, a), a).toThrow(PathTraversalError);
    }
  });

  it('rejects symlink escapes', () => {
    const outside = makeTempDir('sooya-outside-');
    fs.writeFileSync(path.join(outside, 'target.txt'), 'secret');
    const link = path.join(root, 'link.txt');
    try {
      fs.symlinkSync(path.join(outside, 'target.txt'), link);
    } catch {
      return; // symlinks unsupported
    }
    expect(() => safeJoin(root, 'link.txt')).toThrow(PathTraversalError);
  });
});

describe('SSRF protection', () => {
  it('classifies private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.9.9', '169.254.169.254', '::1', 'fd00::1', '0.0.0.0']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('blocks dangerous protocols and private hosts', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('ftp://example.com/x')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('data:text/plain,hi')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('http://127.0.0.1:8788/admin')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('http://localhost/x')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(SsrfError);
    await expect(assertSafeUrl('http://[::1]/x')).rejects.toBeInstanceOf(SsrfError);
  });

  it('allows private addresses only when explicitly permitted', async () => {
    await expect(assertSafeUrl('http://127.0.0.1:1/x', true)).resolves.toBeInstanceOf(URL);
  });
});

describe('retry helper', () => {
  it('retries retryable errors then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new HttpTimeoutError('slow');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 1 }
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new SsrfError('nope');
        },
        { retries: 3, baseDelayMs: 1 }
      )
    ).rejects.toBeInstanceOf(SsrfError);
    expect(attempts).toBe(1);
  });

  it('classifies 5xx/429 as retryable', () => {
    expect(defaultRetryable(new Error('request failed with status 503'))).toBe(true);
    expect(defaultRetryable(new Error('request failed with status 429'))).toBe(true);
    expect(defaultRetryable(new Error('request failed with status 400'))).toBe(false);
  });
});

describe('secret redaction', () => {
  it('masks keys in objects', () => {
    const out = redactSecrets({ apiKey: 'sk-abcdef1234567890', nested: { authorization: 'Bearer xyz123456' } }) as any;
    expect(out.apiKey).not.toContain('abcdef1234567890');
    expect(JSON.stringify(out)).not.toContain('xyz123456');
  });

  it('masks keys inside strings', () => {
    expect(redactStringSecrets('using sk-abcdefghijklmnop now')).not.toContain('ghijklmnop');
    expect(redactStringSecrets('Authorization: Bearer supersecrettoken')).not.toContain('supersecrettoken');
    expect(redactStringSecrets('/api/media/x?token=chat-secret-123')).not.toContain('chat-secret-123');
    expect(redactStringSecrets('/api/media/x?admin_token=admin-secret-123')).not.toContain('admin-secret-123');
  });

  it('masks short and long secrets', () => {
    expect(maskSecret('short')).toBe('***');
    expect(maskSecret('sk-1234567890')).toBe('sk-***90');
  });
});

describe('audio probing', () => {
  it('reads WAV duration exactly', () => {
    const wav = buildWav(new Float32Array(16000), 16000);
    expect(detectContainer(wav)).toBe('wav');
    expect(probeAudioDuration(wav)).toBeCloseTo(1, 2);
  });

  it('reads a 2s WAV', () => {
    expect(probeAudioDuration(makeFakeWav(2))).toBeCloseTo(2, 1);
  });

  it('reads MP3 frame-based duration', () => {
    const mp3 = makeFakeMp3(40); // 40 frames * 1152 / 44100
    expect(detectContainer(mp3)).toBe('mp3');
    const d = probeAudioDuration(mp3);
    expect(d).not.toBeNull();
    expect(d!).toBeCloseTo((40 * 1152) / 44100, 1);
  });

  it('returns null for unknown data instead of guessing', () => {
    expect(probeAudioDuration(Buffer.from('not audio at all, really not'))).toBeNull();
  });
});

describe('image probing', () => {
  it('reads PNG size', () => {
    expect(probeImageSize(TEST_PNG)).toEqual({ width: 1, height: 1 });
  });

  it('reads generated sticker sizes', () => {
    const p = fileURLToPath(new URL('./fixtures/stickers/happy.png', import.meta.url));
    const size = probeImageSize(fs.readFileSync(p));
    expect(size).toEqual({ width: 128, height: 128 });
  });
});

describe('memory helpers', () => {
  it('normalizes text for dedupe', () => {
    expect(normalizeMemoryText('用户喜欢 猫。')).toBe(normalizeMemoryText('用户喜欢猫'));
  });

  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('round-trips embeddings through blobs', () => {
    const vec = [0.5, -0.25, 0.125, 1];
    const back = bufferToFloats(floatsToBuffer(vec));
    expect(back.length).toBe(4);
    for (let i = 0; i < 4; i++) expect(back[i]).toBeCloseTo(vec[i]!, 5);
  });

  it('parses model extraction output, including fenced json', () => {
    const items = parseCandidates('```json\n{"worth":true,"items":[{"kind":"profile","content":"用户叫小明","importance":0.9}]}\n```');
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('profile');
    expect(parseCandidates('{"worth":false,"items":[]}')).toHaveLength(0);
    expect(parseCandidates('total garbage')).toHaveLength(0);
  });
});

describe('emotion guessing', () => {
  it('maps text to sticker emotions', () => {
    expect(guessEmotion('哈哈哈太好笑了')).toBe('开心');
    expect(guessEmotion('我今天很难过')).toBe('难过');
    expect(guessEmotion('晚安啦')).toBe('晚安');
  });
});

describe('atomic writes and temp cleanup', () => {
  it('writes atomically and leaves no temp files', () => {
    const dir = makeTempDir('sooya-atomic-');
    const target = path.join(dir, 'config.json');
    atomicWriteFileSync(target, '{"a":1}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.tmp-'))).toHaveLength(0);
  });

  it('cleans stale temp files only', async () => {
    const dir = makeTempDir('sooya-tmp-');
    const stale = path.join(dir, '.tmp-old');
    const fresh = path.join(dir, '.tmp-new');
    const keep = path.join(dir, 'real.txt');
    fs.writeFileSync(stale, 'x');
    fs.writeFileSync(fresh, 'x');
    fs.writeFileSync(keep, 'x');
    const old = Date.now() - 24 * 3600 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);
    const removed = await cleanupTempFiles([dir]);
    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(keep)).toBe(true);
  });
});

