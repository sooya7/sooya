/**
 * Dependency-free audio duration probing for the formats SOOYA stores.
 * Returns null when the duration cannot be determined reliably; callers must
 * then fall back to a client-provided duration rather than inventing one.
 */

export function probeAudioDuration(buf: Buffer, mime?: string): number | null {
  if (buf.byteLength < 12) return null;
  const kind = detectContainer(buf, mime);
  switch (kind) {
    case 'wav':
      return wavDuration(buf);
    case 'mp3':
      return mp3Duration(buf);
    case 'ogg':
      return oggDuration(buf);
    case 'webm':
      return webmDuration(buf);
    case 'mp4':
      return mp4Duration(buf);
    case 'flac':
      return flacDuration(buf);
    default:
      return null;
  }
}

export function detectContainer(buf: Buffer, mime?: string): 'wav' | 'mp3' | 'ogg' | 'webm' | 'mp4' | 'flac' | 'unknown' {
  const ascii = (start: number, len: number) => buf.subarray(start, start + len).toString('latin1');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (ascii(4, 4) === 'ftyp') return 'mp4';
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'mp3';
  if (mime) {
    if (mime.includes('wav')) return 'wav';
    if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
    if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'mp4';
    if (mime.includes('flac')) return 'flac';
  }
  return 'unknown';
}

function wavDuration(buf: Buffer): number | null {
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= buf.byteLength) {
    const id = buf.subarray(offset, offset + 4).toString('latin1');
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 8 + 16 <= buf.byteLength) {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      byteRate = buf.readUInt32LE(offset + 16);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataSize = Math.min(size, buf.byteLength - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataSize <= 0) return null;
  if (byteRate > 0) return round(dataSize / byteRate);
  if (sampleRate > 0 && channels > 0 && bitsPerSample > 0) {
    return round(dataSize / (sampleRate * channels * (bitsPerSample / 8)));
  }
  return null;
}

const MPEG_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000] // MPEG2.5
};

function mp3Duration(buf: Buffer): number | null {
  let pos = 0;
  // Skip ID3v2
  if (buf.subarray(0, 3).toString('latin1') === 'ID3' && buf.byteLength > 10) {
    const size =
      ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
    pos = 10 + size;
  }
  let totalSamples = 0;
  let sampleRate = 0;
  let frames = 0;
  let bitrateSum = 0;
  while (pos + 4 <= buf.byteLength) {
    if (buf[pos] !== 0xff || (buf[pos + 1]! & 0xe0) !== 0xe0) {
      pos++;
      continue;
    }
    const b1 = buf[pos + 1]!;
    const b2 = buf[pos + 2]!;
    const versionBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    if (versionBits === 1 || layerBits === 0) {
      pos++;
      continue;
    }
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const rateIdx = (b2 >> 2) & 0x03;
    if (bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) {
      pos++;
      continue;
    }
    const table = versionBits === 3 ? MPEG_BITRATES_V1_L3 : MPEG_BITRATES_V2_L3;
    const bitrate = table[bitrateIdx]! * 1000;
    const rates = SAMPLE_RATES[versionBits] ?? SAMPLE_RATES[3]!;
    sampleRate = rates[rateIdx]!;
    if (!bitrate || !sampleRate) {
      pos++;
      continue;
    }
    const samplesPerFrame = versionBits === 3 ? 1152 : 576;
    const padding = (b2 >> 1) & 0x01;
    const frameLen = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
    if (frameLen <= 4) {
      pos++;
      continue;
    }
    totalSamples += samplesPerFrame;
    bitrateSum += bitrate;
    frames++;
    pos += frameLen;
    if (frames > 200000) break;
  }
  if (frames === 0 || sampleRate === 0) return null;
  return round(totalSamples / sampleRate);
}

function oggDuration(buf: Buffer): number | null {
  // Find last OggS page and read its granule position.
  let lastPage = -1;
  for (let i = buf.byteLength - 27; i >= 0; i--) {
    if (buf[i] === 0x4f && buf[i + 1] === 0x67 && buf[i + 2] === 0x67 && buf[i + 3] === 0x53) {
      lastPage = i;
      break;
    }
  }
  if (lastPage < 0) return null;
  const granule = Number(buf.readBigUInt64LE(lastPage + 6));
  if (!Number.isFinite(granule) || granule <= 0) return null;
  // Detect codec from first page for the sample rate.
  const head = buf.subarray(0, Math.min(buf.byteLength, 4096)).toString('latin1');
  if (head.includes('OpusHead')) {
    const idx = head.indexOf('OpusHead');
    const preSkip = buf.readUInt16LE(idx + 10);
    return round(Math.max(0, granule - preSkip) / 48000);
  }
  if (head.includes('vorbis')) {
    const idx = head.indexOf('vorbis');
    const rate = buf.readUInt32LE(idx + 11);
    if (rate > 0) return round(granule / rate);
  }
  return round(granule / 48000);
}

function webmDuration(buf: Buffer): number | null {
  // Minimal EBML scan for TimecodeScale (0x2AD7B1) + Duration (0x4489).
  let timecodeScale = 1_000_000;
  let duration: number | null = null;
  for (let i = 0; i + 12 < buf.byteLength && i < 4_000_000; i++) {
    if (buf[i] === 0x2a && buf[i + 1] === 0xd7 && buf[i + 2] === 0xb1) {
      const len = buf[i + 3]! & 0x7f;
      if (len >= 1 && len <= 8 && i + 4 + len <= buf.byteLength) {
        let v = 0;
        for (let k = 0; k < len; k++) v = v * 256 + buf[i + 4 + k]!;
        if (v > 0) timecodeScale = v;
      }
    } else if (buf[i] === 0x44 && buf[i + 1] === 0x89) {
      const sizeByte = buf[i + 2]!;
      const len = sizeByte & 0x7f;
      if (len === 4 && i + 3 + 4 <= buf.byteLength) duration = buf.readFloatBE(i + 3);
      else if (len === 8 && i + 3 + 8 <= buf.byteLength) duration = buf.readDoubleBE(i + 3);
    }
  }
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return null;
  return round((duration * timecodeScale) / 1e9);
}

function mp4Duration(buf: Buffer): number | null {
  const marker = Buffer.from('mvhd', 'latin1');
  const idx = buf.indexOf(marker);
  if (idx < 0) return null;
  const version = buf[idx + 4]!;
  try {
    if (version === 1) {
      const timescale = buf.readUInt32BE(idx + 20);
      const dur = Number(buf.readBigUInt64BE(idx + 24));
      return timescale > 0 ? round(dur / timescale) : null;
    }
    const timescale = buf.readUInt32BE(idx + 12);
    const dur = buf.readUInt32BE(idx + 16);
    return timescale > 0 ? round(dur / timescale) : null;
  } catch {
    return null;
  }
}

function flacDuration(buf: Buffer): number | null {
  // STREAMINFO block starts at byte 8.
  if (buf.byteLength < 26) return null;
  const sampleRate = (buf[18]! << 12) | (buf[19]! << 4) | (buf[20]! >> 4);
  const totalSamples =
    ((buf[21]! & 0x0f) * 2 ** 32) + buf[22]! * 2 ** 24 + buf[23]! * 2 ** 16 + buf[24]! * 2 ** 8 + buf[25]!;
  if (!sampleRate || !totalSamples) return null;
  return round(totalSamples / sampleRate);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Build a minimal valid PCM WAV file (used by tests and the local TTS fallback). */
export function buildWav(samples: Float32Array, sampleRate = 16000): Buffer {
  const numSamples = samples.length;
  const buffer = Buffer.alloc(44 + numSamples * 2);
  buffer.write('RIFF', 0, 'latin1');
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8, 'latin1');
  buffer.write('fmt ', 12, 'latin1');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'latin1');
  buffer.writeUInt32LE(numSamples * 2, 40);
  for (let i = 0; i < numSamples; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buffer;
}
