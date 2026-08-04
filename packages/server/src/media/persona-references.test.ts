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

  const FRAMES = ['01_main_reference_front_half.png', '02_reference_full_body_standing.png', '03_reference_side_profile.png'];

  async function makeFramedDir(): Promise<string> {
    const dir = await makeDir();
    for (const name of FRAMES) await writeFile(path.join(dir, name), Buffer.from(name));
    return dir;
  }

  it('侧脸 prompt 自动选中侧面参考图', async () => {
    const dir = await makeFramedDir();
    const loader = new PersonaReferenceLoader(dir, () => FRAMES);
    const refs = await loader.load('侧颜特写，夕阳下的侧脸');
    expect(refs[0]?.name).toBe('03_reference_side_profile.png');
  });

  it('全身 prompt 自动选中站姿参考图', async () => {
    const dir = await makeFramedDir();
    const loader = new PersonaReferenceLoader(dir, () => FRAMES);
    const refs = await loader.load('a full body shot, standing in the park');
    expect(refs[0]?.name).toBe('02_reference_full_body_standing.png');
  });

  it('无视角线索或无 hint 时用第一张（正面半身）', async () => {
    const dir = await makeFramedDir();
    const loader = new PersonaReferenceLoader(dir, () => FRAMES);
    expect((await loader.load('微笑自拍'))[0]?.name).toBe('01_main_reference_front_half.png');
    expect((await loader.load())[0]?.name).toBe('01_main_reference_front_half.png');
  });

  it('选中的参考图缺失时回退到第一张可读的', async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, '01_main_reference_front_half.png'), Buffer.from('front'));
    await writeFile(path.join(dir, '02_reference_full_body_standing.png'), Buffer.from('full'));
    // 03 缺失
    const loader = new PersonaReferenceLoader(dir, () => FRAMES);
    const refs = await loader.load('侧脸');
    expect(refs[0]?.name).toBe('01_main_reference_front_half.png');
  });
});
