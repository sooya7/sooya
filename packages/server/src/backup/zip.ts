import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const MAX_U32 = 0xffffffff;

export interface ZipSource {
  /** POSIX-style path stored in the archive. */
  name: string;
  path: string;
}

export interface ExtractZipOptions {
  maxFiles?: number;
  maxBytes?: number;
}

type CentralEntry = {
  name: string;
  crc32: number;
  compressedSize: number;
  size: number;
  method: number;
  flags: number;
  localOffset: number;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();

function updateCrc(crc: number, chunk: Buffer): number {
  let value = crc;
  for (const byte of chunk) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

export async function crc32File(file: string): Promise<number> {
  let crc = 0xffffffff;
  for await (const chunk of fs.createReadStream(file)) crc = updateCrc(crc, chunk as Buffer);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { date: dosDate, time: dosTime };
}

function archiveName(raw: string): string {
  const name = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0')) throw new Error(`unsafe zip entry name: ${raw}`);
  const normalized = path.posix.normalize(name);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`unsafe zip entry name: ${raw}`);
  return normalized;
}

async function writeAll(handle: fsp.FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const result = await handle.write(data, offset, data.length - offset, null);
    offset += result.bytesWritten;
  }
}

/**
 * Writes a standards-compliant ZIP using STORE entries. Media is already
 * compressed in practice, and STORE lets us stream multi-hundred-MB backups
 * without holding the archive or a whole media tree in memory.
 */
export async function createStoredZip(sources: ZipSource[], target: string): Promise<{ bytes: number; fileCount: number }> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.part-${process.pid}-${Date.now()}`;
  const handle = await fsp.open(tmp, 'wx');
  const central: Array<CentralEntry & { nameBytes: Buffer; date: number; time: number }> = [];
  let offset = 0;
  try {
    for (const source of sources) {
      const name = archiveName(source.name);
      const nameBytes = Buffer.from(name, 'utf8');
      if (nameBytes.length > 0xffff) throw new Error(`zip entry name too long: ${name}`);
      const stat = await fsp.stat(source.path);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_U32 || offset > MAX_U32) throw new Error('ZIP64 backup is not supported');
      const crc32 = await crc32File(source.path);
      const stamp = dosDateTime(stat.mtime);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(LOCAL_SIGNATURE, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0, 6);
      header.writeUInt16LE(0, 8); // STORE
      header.writeUInt16LE(stamp.time, 10);
      header.writeUInt16LE(stamp.date, 12);
      header.writeUInt32LE(crc32, 14);
      header.writeUInt32LE(stat.size, 18);
      header.writeUInt32LE(stat.size, 22);
      header.writeUInt16LE(nameBytes.length, 26);
      header.writeUInt16LE(0, 28);
      const localOffset = offset;
      await writeAll(handle, header);
      await writeAll(handle, nameBytes);
      offset += header.length + nameBytes.length;
      for await (const chunk of fs.createReadStream(source.path)) {
        const buf = chunk as Buffer;
        await writeAll(handle, buf);
        offset += buf.length;
      }
      central.push({ name, nameBytes, crc32, compressedSize: stat.size, size: stat.size, method: 0, flags: 0, localOffset, ...stamp });
    }

    const centralOffset = offset;
    for (const entry of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(entry.flags, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc32, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBytes.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.localOffset, 42);
      await writeAll(handle, header);
      await writeAll(handle, entry.nameBytes);
      offset += header.length + entry.nameBytes.length;
    }
    const centralSize = offset - centralOffset;
    if (central.length > 0xffff || centralOffset > MAX_U32 || centralSize > MAX_U32) throw new Error('ZIP64 backup is not supported');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    await writeAll(handle, eocd);
    offset += eocd.length;
    await handle.sync();
    await handle.close();
    await fsp.rename(tmp, target);
    return { bytes: offset, fileCount: central.length };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readExactly(handle: fsp.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) throw new Error('unexpected end of zip');
    read += result.bytesRead;
  }
  return buffer;
}

async function centralEntries(archive: string): Promise<CentralEntry[]> {
  const handle = await fsp.open(archive, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 22) throw new Error('invalid zip archive');
    const tailSize = Math.min(stat.size, 65_557);
    const tail = await readExactly(handle, tailSize, stat.size - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip end record not found');
    const count = tail.readUInt16LE(eocd + 10);
    const size = tail.readUInt32LE(eocd + 12);
    const offset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || size === MAX_U32 || offset === MAX_U32) throw new Error('ZIP64 backup is not supported');
    if (offset + size > stat.size) throw new Error('invalid zip central directory');
    const central = await readExactly(handle, size, offset);
    const entries: CentralEntry[] = [];
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error('invalid zip central entry');
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const crc32 = central.readUInt32LE(cursor + 16);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > central.length) throw new Error('invalid zip central entry length');
      const name = archiveName(central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
      if ((flags & 0x1) !== 0) throw new Error('encrypted zip entries are not supported');
      if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method: ${method}`);
      entries.push({ name, crc32, compressedSize, size: uncompressedSize, method, flags, localOffset });
      cursor = end;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

function destinationFor(root: string, name: string): string {
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, ...name.split('/'));
  if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`unsafe zip entry path: ${name}`);
  return destination;
}

export async function extractZip(archive: string, destination: string, options: ExtractZipOptions = {}): Promise<{ fileCount: number; bytes: number }> {
  const maxFiles = options.maxFiles ?? 10_000;
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const entries = await centralEntries(archive);
  const files = entries.filter((entry) => !entry.name.endsWith('/'));
  const total = files.reduce((sum, entry) => sum + entry.size, 0);
  if (files.length > maxFiles) throw new Error(`backup contains too many files: ${files.length}`);
  if (total > maxBytes) throw new Error(`backup expands beyond limit: ${total}`);
  await fsp.mkdir(destination, { recursive: true });
  const handle = await fsp.open(archive, 'r');
  try {
    for (const entry of files) {
      const local = await readExactly(handle, 30, entry.localOffset);
      if (local.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`invalid local zip header: ${entry.name}`);
      const nameLength = local.readUInt16LE(26);
      const extraLength = local.readUInt16LE(28);
      const dataStart = entry.localOffset + 30 + nameLength + extraLength;
      const dataEnd = dataStart + entry.compressedSize - 1;
      const target = destinationFor(destination, entry.name);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      if (entry.compressedSize === 0) {
        await fsp.writeFile(target, Buffer.alloc(0));
      } else if (entry.method === 0) {
        await pipeline(fs.createReadStream(archive, { start: dataStart, end: dataEnd }), fs.createWriteStream(target, { flags: 'wx' }));
      } else {
        await pipeline(fs.createReadStream(archive, { start: dataStart, end: dataEnd }), createInflateRaw(), fs.createWriteStream(target, { flags: 'wx' }));
      }
      const stat = await fsp.stat(target);
      if (stat.size !== entry.size) throw new Error(`zip size mismatch: ${entry.name}`);
      if (await crc32File(target) !== entry.crc32) throw new Error(`zip checksum mismatch: ${entry.name}`);
    }
    return { fileCount: files.length, bytes: total };
  } catch (error) {
    await fsp.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}
