#!/usr/bin/env node
/**
 * Generates SOOYA's avatars (SVG) and PWA icons (PNG).
 * All artwork is produced here programmatically — no third-party marks or assets.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_PUBLIC = path.resolve(__dirname, '..', 'packages', 'web', 'public');
const AVATAR_DIR = path.join(WEB_PUBLIC, 'avatars');
const ICON_DIR = path.join(WEB_PUBLIC, 'icons');

fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(ICON_DIR, { recursive: true });

/* --------------------------------- SVGs ---------------------------------- */

const sooyaAvatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="SOOYA">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7ec8ff"/>
      <stop offset="100%" stop-color="#3aa1ff"/>
    </linearGradient>
  </defs>
  <circle cx="64" cy="64" r="64" fill="url(#g)"/>
  <circle cx="64" cy="58" r="34" fill="#ffffff" opacity="0.16"/>
  <ellipse cx="50" cy="58" rx="5.5" ry="7.5" fill="#ffffff"/>
  <ellipse cx="78" cy="58" rx="5.5" ry="7.5" fill="#ffffff"/>
  <path d="M50 78c4.5 5 9 7.4 14 7.4S73.5 83 78 78" fill="none" stroke="#ffffff" stroke-width="4.5" stroke-linecap="round"/>
  <circle cx="36" cy="72" r="6" fill="#ffffff" opacity="0.28"/>
  <circle cx="92" cy="72" r="6" fill="#ffffff" opacity="0.28"/>
</svg>
`;

const userAvatar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="我">
  <circle cx="64" cy="64" r="64" fill="#dfe3e8"/>
  <circle cx="64" cy="50" r="21" fill="#a8b1bd"/>
  <path d="M22 116a42 42 0 0 1 84 0z" fill="#a8b1bd"/>
</svg>
`;

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8ed0ff"/>
      <stop offset="100%" stop-color="#2f95e0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <path d="M136 176c0-26 21-47 47-47h146c26 0 47 21 47 47v106c0 26-21 47-47 47H236l-62 48v-48h-9c-16 0-29-13-29-29z" fill="#ffffff" opacity="0.95"/>
  <circle cx="212" cy="230" r="17" fill="#2f95e0"/>
  <circle cx="268" cy="230" r="17" fill="#2f95e0"/>
  <circle cx="324" cy="230" r="17" fill="#2f95e0"/>
</svg>
`;

fs.writeFileSync(path.join(AVATAR_DIR, 'sooya.svg'), sooyaAvatar);
fs.writeFileSync(path.join(AVATAR_DIR, 'user.svg'), userAvatar);
fs.writeFileSync(path.join(ICON_DIR, 'icon.svg'), appIcon);

/* ------------------------------- PNG icons -------------------------------- */

function crc32(buf) {
  const table =
    crc32.table ||
    (crc32.table = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
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
  const t = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = pixels[y * size * 4 + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Draw the app icon: rounded gradient square + speech bubble with three dots. */
function drawIcon(size, maskable) {
  const px = new Uint8ClampedArray(size * size * 4);
  const s = size / 512;
  const radius = maskable ? size / 2 : 112 * s;
  const inset = maskable ? size * 0.1 : 0; // maskable icons need a safe zone

  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    px[i] = (r * sa + px[i] * da * (1 - sa)) / oa;
    px[i + 1] = (g * sa + px[i + 1] * da * (1 - sa)) / oa;
    px[i + 2] = (b * sa + px[i + 2] * da * (1 - sa)) / oa;
    px[i + 3] = oa * 255;
  };

  // Background with rounded corners and a diagonal gradient.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inCorner = roundedRectAlpha(x + 0.5, y + 0.5, 0, 0, size, size, radius);
      if (inCorner <= 0) continue;
      const t = (x / size + y / size) / 2;
      const r = Math.round(142 + (47 - 142) * t);
      const g = Math.round(208 + (149 - 208) * t);
      const b = Math.round(255 + (224 - 255) * t);
      set(x, y, r, g, b, 255 * inCorner);
    }
  }

  // Speech bubble.
  const bx = 136 * s + inset * 0.5;
  const by = 129 * s + inset * 0.5;
  const bw = (376 - 136) * s - inset;
  const bh = (329 - 129) * s - inset;
  const br = 47 * s;
  for (let y = Math.floor(by); y < by + bh; y++) {
    for (let x = Math.floor(bx); x < bx + bw; x++) {
      const a = roundedRectAlpha(x + 0.5, y + 0.5, bx, by, bw, bh, br);
      if (a > 0) set(x, y, 255, 255, 255, 242 * a);
    }
  }
  // Bubble tail.
  const tailTopY = by + bh - 1;
  const tailH = 46 * s;
  for (let y = 0; y < tailH; y++) {
    const w = (1 - y / tailH) * 46 * s;
    for (let x = 0; x < w; x++) set(Math.round(bx + 38 * s + x), Math.round(tailTopY + y), 255, 255, 255, 242);
  }
  // Three dots.
  const dotY = by + bh * 0.5;
  for (const cx of [bx + bw * 0.27, bx + bw * 0.5, bx + bw * 0.73]) {
    const r = 17 * s * (maskable ? 0.9 : 1);
    for (let y = Math.floor(dotY - r) - 1; y <= dotY + r + 1; y++) {
      for (let x = Math.floor(cx - r) - 1; x <= cx + r + 1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - dotY);
        if (d <= r - 0.5) set(x, y, 47, 149, 224, 255);
        else if (d < r + 0.5) set(x, y, 47, 149, 224, 255 * (r + 0.5 - d));
      }
    }
  }
  return px;
}

function roundedRectAlpha(px, py, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  const cx = Math.min(Math.max(px, x + rr), x + w - rr);
  const cy = Math.min(Math.max(py, y + rr), y + h - rr);
  const d = Math.hypot(px - cx, py - cy);
  if (px < x || py < y || px > x + w || py > y + h) return 0;
  if (d <= rr - 0.5) return 1;
  if (d < rr + 0.5) return rr + 0.5 - d;
  return d <= rr ? 1 : 0;
}

for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true]
]) {
  fs.writeFileSync(path.join(ICON_DIR, name), encodePng(size, drawIcon(size, maskable)));
}

console.log(`icons written to ${ICON_DIR}, avatars to ${AVATAR_DIR}`);
