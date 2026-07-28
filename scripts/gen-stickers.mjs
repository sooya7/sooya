#!/usr/bin/env node
/**
 * Generates SOOYA's built-in sticker pack as real image files.
 * Everything is drawn programmatically here (no third-party artwork), so the
 * repository ships a small, license-clean, offline-usable sticker set.
 *
 * Output: assets/stickers/*.png, *.gif + manifest.json
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'assets', 'stickers');

const SIZE = 128;

/* ------------------------------ tiny canvas ------------------------------ */

class Canvas {
  constructor(size) {
    this.size = size;
    // RGBA
    this.data = new Uint8ClampedArray(size * size * 4);
  }
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    const srcA = a / 255;
    const dstA = this.data[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA === 0) {
      this.data[i] = this.data[i + 1] = this.data[i + 2] = this.data[i + 3] = 0;
      return;
    }
    this.data[i] = (r * srcA + this.data[i] * dstA * (1 - srcA)) / outA;
    this.data[i + 1] = (g * srcA + this.data[i + 1] * dstA * (1 - srcA)) / outA;
    this.data[i + 2] = (b * srcA + this.data[i + 2] * dstA * (1 - srcA)) / outA;
    this.data[i + 3] = outA * 255;
  }
  fillCircle(cx, cy, r, color) {
    for (let y = Math.floor(cy - r) - 1; y <= Math.ceil(cy + r) + 1; y++) {
      for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r - 0.5) this.set(x, y, color);
        else if (d < r + 0.5) this.set(x, y, [color[0], color[1], color[2], (color[3] ?? 255) * (r + 0.5 - d)]);
      }
    }
  }
  fillEllipse(cx, cy, rx, ry, color) {
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y++) {
      for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        const d = Math.hypot(dx, dy);
        if (d <= 1) this.set(x, y, color);
      }
    }
  }
  fillRect(x0, y0, w, h, color) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, color);
  }
  stroke(points, color, width = 3) {
    for (let i = 0; i < points.length - 1; i++) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[i + 1];
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
      for (let s = 0; s <= steps; s++) {
        const t = steps === 0 ? 0 : s / steps;
        this.fillCircle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, color);
      }
    }
  }
  arc(cx, cy, r, a0, a1, color, width = 3) {
    const pts = [];
    const steps = 40;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    this.stroke(pts, color, width);
  }
}

/* -------------------------------- encoders -------------------------------- */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = data[y * size * 4 + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Minimal animated GIF encoder with a fixed palette and uncompressed-ish LZW. */
function encodeGif(frames, size, delayCs = 40) {
  const palette = [];
  const paletteIndex = new Map();
  const quant = (r, g, b) => {
    // 6 levels per channel -> 216 colors, fits GIF's 256 entry table.
    const q = (v) => Math.round((v / 255) * 5);
    const key = `${q(r)},${q(g)},${q(b)}`;
    if (!paletteIndex.has(key)) {
      const [qr, qg, qb] = key.split(',').map(Number);
      paletteIndex.set(key, palette.length);
      palette.push([Math.round((qr / 5) * 255), Math.round((qg / 5) * 255), Math.round((qb / 5) * 255)]);
    }
    return paletteIndex.get(key);
  };

  const indexedFrames = frames.map((canvas) => {
    const idx = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i++) {
      const a = canvas.data[i * 4 + 3];
      if (a < 128) {
        idx[i] = -1 >>> 0 & 0xff; // placeholder, set later
        idx[i] = 255;
      } else {
        idx[i] = quant(canvas.data[i * 4], canvas.data[i * 4 + 1], canvas.data[i * 4 + 2]);
      }
    }
    return idx;
  });
  // Reserve index 255 for transparency.
  while (palette.length < 256) palette.push([255, 255, 255]);

  const out = [];
  out.push(Buffer.from('GIF89a', 'latin1'));
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(size, 0);
  lsd.writeUInt16LE(size, 2);
  lsd[4] = 0xf7; // global color table, 256 entries
  lsd[5] = 255; // background index
  lsd[6] = 0;
  out.push(lsd);
  const gct = Buffer.alloc(256 * 3);
  palette.forEach(([r, g, b], i) => {
    gct[i * 3] = r;
    gct[i * 3 + 1] = g;
    gct[i * 3 + 2] = b;
  });
  out.push(gct);
  // Netscape looping extension
  out.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));

  for (const idx of indexedFrames) {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x09, delayCs & 0xff, (delayCs >> 8) & 0xff, 255, 0x00]);
    out.push(gce);
    const img = Buffer.alloc(10);
    img[0] = 0x2c;
    img.writeUInt16LE(0, 1);
    img.writeUInt16LE(0, 3);
    img.writeUInt16LE(size, 5);
    img.writeUInt16LE(size, 7);
    img[9] = 0;
    out.push(img);
    out.push(lzwEncode(idx, 8));
  }
  out.push(Buffer.from([0x3b]));
  return Buffer.concat(out);
}

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  const resetDict = () => {
    dict = new Map();
    for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
    return eoiCode + 1;
  };
  let next = resetDict();
  const bits = [];
  let cur = 0;
  let curBits = 0;
  const bytes = [];
  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      bytes.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };
  emit(clearCode);
  let prefix = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const combined = `${prefix},${k}`;
    if (dict.has(combined)) {
      prefix = combined;
    } else {
      emit(dict.get(prefix));
      dict.set(combined, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
      else if (next >= 4096) {
        emit(clearCode);
        next = resetDict();
        codeSize = minCodeSize + 1;
      }
      prefix = String(k);
    }
  }
  emit(dict.get(prefix));
  emit(eoiCode);
  if (curBits > 0) bytes.push(cur & 0xff);
  void bits;
  // Split into sub-blocks
  const chunks = [Buffer.from([minCodeSize])];
  for (let i = 0; i < bytes.length; i += 255) {
    const slice = bytes.slice(i, i + 255);
    chunks.push(Buffer.from([slice.length]), Buffer.from(slice));
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/* --------------------------------- faces ---------------------------------- */

const INK = [60, 52, 70, 255];
const WHITE = [255, 255, 255, 255];

function base(color) {
  const c = new Canvas(SIZE);
  c.fillCircle(64, 64, 56, color);
  c.fillCircle(64, 64, 56, [255, 255, 255, 26]);
  return c;
}

function eyesOpen(c, dy = 0) {
  c.fillEllipse(46, 58 + dy, 7, 9, INK);
  c.fillEllipse(82, 58 + dy, 7, 9, INK);
  c.fillCircle(48, 55 + dy, 2.4, WHITE);
  c.fillCircle(84, 55 + dy, 2.4, WHITE);
}

function eyesHappy(c) {
  c.arc(46, 60, 10, Math.PI, 2 * Math.PI, INK, 4);
  c.arc(82, 60, 10, Math.PI, 2 * Math.PI, INK, 4);
}

function eyesFlat(c) {
  c.stroke([[37, 60], [55, 60]], INK, 4);
  c.stroke([[73, 60], [91, 60]], INK, 4);
}

function blush(c, color = [255, 138, 148, 130]) {
  c.fillEllipse(38, 78, 10, 6, color);
  c.fillEllipse(90, 78, 10, 6, color);
}

function tears(c) {
  c.fillEllipse(40, 76, 4, 9, [120, 190, 255, 220]);
  c.fillEllipse(88, 76, 4, 9, [120, 190, 255, 220]);
}

const DEFS = [
  {
    name: 'happy',
    emotion: '开心',
    tags: ['开心', '高兴', '笑', '哈哈', 'happy'],
    draw: () => {
      const c = base([255, 214, 102, 255]);
      eyesHappy(c);
      c.arc(64, 74, 18, 0.2 * Math.PI, 0.8 * Math.PI, INK, 4);
      blush(c);
      return c;
    }
  },
  {
    name: 'speechless',
    emotion: '无语',
    tags: ['无语', '尴尬', '沉默', '汗', 'speechless'],
    draw: () => {
      const c = base([206, 214, 224, 255]);
      eyesFlat(c);
      c.stroke([[52, 82], [76, 82]], INK, 4);
      c.stroke([[96, 34], [98, 46]], [130, 200, 255, 230], 5);
      return c;
    }
  },
  {
    name: 'angry',
    emotion: '生气',
    tags: ['生气', '愤怒', '哼', 'angry'],
    draw: () => {
      const c = base([255, 138, 128, 255]);
      c.stroke([[36, 48], [56, 56]], INK, 4);
      c.stroke([[92, 48], [72, 56]], INK, 4);
      eyesOpen(c, 6);
      c.arc(64, 92, 16, 1.15 * Math.PI, 1.85 * Math.PI, INK, 4);
      return c;
    }
  },
  {
    name: 'comfort',
    emotion: '安慰',
    tags: ['安慰', '抱抱', '摸头', '别难过', 'comfort'],
    draw: () => {
      const c = base([167, 220, 200, 255]);
      eyesHappy(c);
      c.arc(64, 76, 14, 0.15 * Math.PI, 0.85 * Math.PI, INK, 4);
      c.fillCircle(26, 66, 9, [255, 255, 255, 220]);
      c.fillCircle(102, 66, 9, [255, 255, 255, 220]);
      return c;
    }
  },
  {
    name: 'coy',
    emotion: '撒娇',
    tags: ['撒娇', '求求', '卖萌', 'coy'],
    draw: () => {
      const c = base([255, 183, 213, 255]);
      eyesHappy(c);
      c.fillEllipse(64, 78, 7, 6, INK);
      blush(c, [255, 110, 140, 150]);
      c.stroke([[48, 26], [64, 14], [80, 26]], [255, 255, 255, 200], 4);
      return c;
    }
  },
  {
    name: 'shy',
    emotion: '害羞',
    tags: ['害羞', '不好意思', '脸红', 'shy'],
    draw: () => {
      const c = base([255, 205, 210, 255]);
      eyesFlat(c);
      c.arc(64, 74, 12, 0.2 * Math.PI, 0.8 * Math.PI, INK, 3);
      blush(c, [244, 90, 120, 170]);
      return c;
    }
  },
  {
    name: 'confused',
    emotion: '疑惑',
    tags: ['疑惑', '问号', '不懂', '？', 'confused'],
    draw: () => {
      const c = base([187, 205, 255, 255]);
      eyesOpen(c);
      c.arc(64, 86, 10, 1.1 * Math.PI, 1.9 * Math.PI, INK, 3);
      c.arc(98, 34, 8, 1.0 * Math.PI, 2.4 * Math.PI, INK, 4);
      c.stroke([[98, 42], [98, 48]], INK, 4);
      c.fillCircle(98, 54, 2.6, INK);
      return c;
    }
  },
  {
    name: 'sad',
    emotion: '难过',
    tags: ['难过', '伤心', '哭', 'sad'],
    draw: () => {
      const c = base([176, 190, 210, 255]);
      c.stroke([[36, 52], [54, 46]], INK, 3);
      c.stroke([[92, 52], [74, 46]], INK, 3);
      eyesOpen(c, 4);
      tears(c);
      c.arc(64, 94, 14, 1.15 * Math.PI, 1.85 * Math.PI, INK, 4);
      return c;
    }
  },
  {
    name: 'smug',
    emotion: '得意',
    tags: ['得意', '骄傲', '嘿嘿', 'smug'],
    draw: () => {
      const c = base([255, 196, 140, 255]);
      c.stroke([[36, 52], [56, 48]], INK, 3);
      c.stroke([[92, 52], [72, 48]], INK, 3);
      eyesFlat(c);
      c.stroke([[50, 80], [66, 86], [80, 76]], INK, 4);
      return c;
    }
  },
  {
    name: 'goodnight',
    emotion: '晚安',
    tags: ['晚安', '睡觉', '困', '安', 'goodnight'],
    draw: () => {
      const c = base([160, 168, 220, 255]);
      c.arc(46, 62, 9, 0, Math.PI, INK, 4);
      c.arc(82, 62, 9, 0, Math.PI, INK, 4);
      c.fillEllipse(64, 82, 6, 8, INK);
      for (const [x, y, s] of [
        [98, 30, 5],
        [106, 42, 4],
        [90, 20, 3]
      ]) {
        c.stroke(
          [
            [x - s, y - s],
            [x + s, y - s],
            [x - s, y + s],
            [x + s, y + s]
          ],
          [255, 255, 255, 235],
          2.5
        );
      }
      return c;
    }
  }
];

/* ---------------------------------- main ---------------------------------- */

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of fs.readdirSync(OUT_DIR)) fs.rmSync(path.join(OUT_DIR, f), { force: true });

const manifest = [];
for (const def of DEFS) {
  const canvas = def.draw();
  const file = `${def.name}.png`;
  fs.writeFileSync(path.join(OUT_DIR, file), encodePng(canvas));
  manifest.push({ name: def.name, file, emotion: def.emotion, tags: def.tags });
}

// One animated GIF so the pack covers more than a single format.
const frames = [];
for (let i = 0; i < 6; i++) {
  const c = base([255, 214, 102, 255]);
  const bounce = Math.sin((i / 6) * Math.PI * 2) * 3;
  c.arc(46, 60 + bounce, 10, Math.PI, 2 * Math.PI, INK, 4);
  c.arc(82, 60 + bounce, 10, Math.PI, 2 * Math.PI, INK, 4);
  c.arc(64, 74 + bounce, 18, 0.2 * Math.PI, 0.8 * Math.PI, INK, 4);
  c.fillEllipse(38, 78 + bounce, 10, 6, [255, 138, 148, 130]);
  c.fillEllipse(90, 78 + bounce, 10, 6, [255, 138, 148, 130]);
  frames.push(c);
}
fs.writeFileSync(path.join(OUT_DIR, 'laugh.gif'), encodeGif(frames, SIZE, 12));
manifest.push({ name: 'laugh', file: 'laugh.gif', emotion: '开心', tags: ['大笑', '哈哈', '开心', 'laugh'] });

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`generated ${manifest.length} stickers into ${OUT_DIR}`);
