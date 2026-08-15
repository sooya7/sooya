import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStoredZip, extractZip } from './zip.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sooya-zip-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe('backup zip utility', () => {
  it('round-trips nested stored files', async () => {
    const root = await tempRoot();
    const sourceA = path.join(root, 'manifest.json');
    const sourceB = path.join(root, 'image.bin');
    await fsp.writeFile(sourceA, '{"format":"test"}');
    await fsp.writeFile(sourceB, Buffer.from([0, 1, 2, 3, 254, 255]));
    const archive = path.join(root, 'backup.zip');

    const created = await createStoredZip([
      { name: 'manifest.json', path: sourceA },
      { name: 'Media/objects/8f6eabf3-452d-4ed7-81f5-e3675d4e4db3', path: sourceB }
    ], archive);
    expect(created.fileCount).toBe(2);

    const out = path.join(root, 'out');
    const extracted = await extractZip(archive, out, { maxBytes: 1024, maxFiles: 10 });
    expect(extracted.fileCount).toBe(2);
    expect(await fsp.readFile(path.join(out, 'manifest.json'), 'utf8')).toBe('{"format":"test"}');
    expect([...await fsp.readFile(path.join(out, 'Media/objects/8f6eabf3-452d-4ed7-81f5-e3675d4e4db3'))]).toEqual([0, 1, 2, 3, 254, 255]);
  });

  it('refuses traversal names before writing an archive', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'payload.txt');
    await fsp.writeFile(file, 'payload');
    await expect(createStoredZip([{ name: '../outside.txt', path: file }], path.join(root, 'bad.zip'))).rejects.toThrow(/unsafe zip entry name/);
  });

  it('refuses absolute paths before writing an archive', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'payload.txt');
    await fsp.writeFile(file, 'payload');
    await expect(createStoredZip([{ name: '/tmp/outside.txt', path: file }], path.join(root, 'absolute.zip'))).rejects.toThrow(/unsafe zip entry name/);
    await expect(createStoredZip([{ name: 'C:\\outside.txt', path: file }], path.join(root, 'windows-absolute.zip'))).rejects.toThrow(/unsafe zip entry name/);
  });

  it('enforces expanded byte limits', async () => {
    const root = await tempRoot();
    const file = path.join(root, 'payload.txt');
    await fsp.writeFile(file, '0123456789');
    const archive = path.join(root, 'backup.zip');
    await createStoredZip([{ name: 'payload.txt', path: file }], archive);
    await expect(extractZip(archive, path.join(root, 'out'), { maxBytes: 5, maxFiles: 10 })).rejects.toThrow(/expands beyond limit/);
  });
});
