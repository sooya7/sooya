/**
 * Minimal ZIP writer (store + deflate), used when the `zip` binary is absent.
 * Produces a standard PKZIP archive readable by any unzip implementation.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

async function walk(dir, base, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      out.push({ rel: `${rel.split(path.sep).join('/')}/`, dir: true, full });
      await walk(full, base, out);
    } else if (entry.isFile()) {
      out.push({ rel: rel.split(path.sep).join('/'), dir: false, full });
    }
  }
  return out;
}

export async function createZip(sourceDir, zipPath, prefix) {
  const entries = await walk(sourceDir, sourceDir);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = `${prefix}/${entry.rel}`;
    const nameBuf = Buffer.from(name, 'utf8');
    const stat = await fsp.stat(entry.full);
    const { time, day } = dosDateTime(stat.mtime);

    let data = Buffer.alloc(0);
    let method = 0;
    let crc = 0;
    let compSize = 0;
    let rawSize = 0;

    if (!entry.dir) {
      const raw = await fsp.readFile(entry.full);
      rawSize = raw.length;
      crc = crc32(raw);
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) {
        data = deflated;
        method = 8;
      } else {
        data = raw;
        method = 0;
      }
      compSize = data.length;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(rawSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0x031e, 4); // made by UNIX
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compSize, 20);
    header.writeUInt32LE(rawSize, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(entry.dir ? 0x10 : 0, 38);
    // External attributes carry the UNIX mode (executable bits for scripts).
    const mode = entry.dir ? 0o40755 : stat.mode & 0o777;
    header.writeUInt32LE((mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fsp.writeFile(zipPath, Buffer.concat([...chunks, centralBuf, end]));
  return fs.statSync(zipPath).size;
}
