import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonaReferenceLoader } from './persona-references.js';

describe('PersonaReferenceLoader', () => {
  const tempDirs: string[] = [];

  async function makeDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'persona-refs-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('成功加载存在的参考图', async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, 'a.png'), Buffer.from('png-bytes'));
    const loader = new PersonaReferenceLoader(dir, () => ['a.png']);
    const refs = await loader.load();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: 'a.png', mime: 'image/png' });
  });

  it('文件缺失时跳过并打 warn，而不是静默降级', async () => {
    const dir = await makeDir();
    const logs: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];
    const loader = new PersonaReferenceLoader(dir, () => ['missing.jpg'], (level, msg, extra) => logs.push({ level, msg, extra }));
    const refs = await loader.load();
    expect(refs).toHaveLength(0);
    expect(logs.some((l) => l.level === 'warn' && l.extra?.name === 'missing.jpg')).toBe(true);
    expect(logs.some((l) => l.msg.includes('all persona reference images failed to load'))).toBe(true);
  });

  it('配置了参考图但目录不存在时打 warn', async () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const loader = new PersonaReferenceLoader(null, () => ['a.png'], (level, msg) => logs.push({ level, msg }));
    expect(await loader.load()).toHaveLength(0);
    expect(logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('未配置参考图时不打日志', async () => {
    const logs: unknown[] = [];
    const loader = new PersonaReferenceLoader(null, () => [], (level, msg) => logs.push({ level, msg }));
    expect(await loader.load()).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('第一张缺失时回退到下一张，且只返回第一张可读的', async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, 'b.png'), Buffer.from('b-bytes'));
    await writeFile(path.join(dir, 'c.png'), Buffer.from('c-bytes'));
    const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
    const loader = new PersonaReferenceLoader(dir, () => ['missing.jpg', 'b.png', 'c.png'], (level, msg, extra) => logs.push({ msg, extra }));
    const refs = await loader.load();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: 'b.png' });
    expect(logs.some((l) => l.extra?.name === 'missing.jpg')).toBe(true);
  });
});
