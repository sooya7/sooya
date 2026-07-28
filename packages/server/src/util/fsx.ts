import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomId } from './ids.js';

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Atomic write: temp file in same dir -> fsync -> rename -> fsync dir. */
export async function atomicWriteFile(target: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${path.basename(target)}-${randomId(8)}`);
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, target);
  await syncDir(dir);
}

export function atomicWriteFileSync(target: string, data: Buffer | string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${path.basename(target)}-${randomId(8)}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try {
    const dfd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* directory fsync unsupported on some platforms */
  }
}

export async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fsp.open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* ignore */
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `candidate` strictly inside `root`. Throws on traversal attempts.
 * Handles `..`, absolute paths, URL-encoded separators and symlink escapes.
 */
export function safeJoin(root: string, candidate: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new PathTraversalError('empty path');
  }
  let decoded = candidate;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  if (decoded.includes('\0')) throw new PathTraversalError('null byte in path');
  // Absolute paths are always rejected rather than silently reinterpreted as
  // relative: a caller passing "/etc/passwd" is never doing something benign.
  if (path.isAbsolute(decoded) || /^[/\\]/.test(decoded) || /^[A-Za-z]:[/\\]/.test(decoded)) {
    throw new PathTraversalError(`absolute path not allowed: ${candidate}`);
  }
  const normalizedRoot = path.resolve(root);
  const joined = path.resolve(normalizedRoot, decoded);
  const rel = path.relative(normalizedRoot, joined);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathTraversalError(`path escapes root: ${candidate}`);
  }
  // Symlink escape check (only when the file already exists).
  try {
    const real = fs.realpathSync(joined);
    const realRoot = fs.realpathSync(normalizedRoot);
    const relReal = path.relative(realRoot, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      throw new PathTraversalError(`symlink escapes root: ${candidate}`);
    }
  } catch (err) {
    if (err instanceof PathTraversalError) throw err;
    /* not existing yet -> fine */
  }
  return joined;
}

export class PathTraversalError extends Error {
  override name = 'PathTraversalError';
}

/** Remove stale temp files (default: older than 6h). */
export async function cleanupTempFiles(dirs: string[], maxAgeMs = 6 * 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith('.tmp-') && !name.startsWith('tmp-')) continue;
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs < cutoff) {
          await fsp.rm(full, { force: true, recursive: true });
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += (await fsp.stat(full)).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}
