import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness, TEST_PNG, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
const tempDirs: string[] = [];
afterEach(async () => {
  if (harness) { await harness.cleanup(); harness = null; }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };

function multipartFile(field: string, filename: string, data: Buffer, mime: string) {
  const boundary = `----sooya${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { ...ADMIN, 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

interface RefBody {
  dir: string | null;
  references: Array<{ name: string; configured: boolean; exists: boolean; bytes: number; framing: string }>;
}

async function withRefsDir() {
  const refsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sooya-refs-'));
  tempDirs.push(refsDir);
  harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token', SOOYA_REFERENCES_DIR: refsDir } });
  return { app: harness.app, refsDir };
}

describe('管理面板参考图管理', () => {
  it('上传的参考图落盘、进名单，并带上识别出的视角', async () => {
    const { app, refsDir } = await withRefsDir();
    const res = await app.server.inject({ method: 'POST', url: '/api/admin/persona/references', ...multipartFile('file', 'my_side_profile.png', TEST_PNG, 'image/png') });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reference: { name: string; framing: string }; referenceImages: string[] };
    expect(body.reference.name).toBe('my_side_profile.png');
    expect(body.reference.framing).toBe('side');
    expect(body.referenceImages).toContain('my_side_profile.png');
    expect(fs.existsSync(path.join(refsDir, 'my_side_profile.png'))).toBe(true);

    const list = (await app.server.inject({ method: 'GET', url: '/api/admin/persona/references', headers: ADMIN })).json() as RefBody;
    const mine = list.references.find((r) => r.name === 'my_side_profile.png');
    expect(mine).toMatchObject({ configured: true, exists: true, framing: 'side' });
  });

  it('预览接口回原图字节，删除接口同时移除名单和文件', async () => {
    const { app, refsDir } = await withRefsDir();
    await app.server.inject({ method: 'POST', url: '/api/admin/persona/references', ...multipartFile('file', 'front.png', TEST_PNG, 'image/png') });

    const data = await app.server.inject({ method: 'GET', url: '/api/admin/persona/references/front.png/data', headers: ADMIN });
    expect(data.statusCode).toBe(200);
    expect(data.headers['content-type']).toContain('image/png');
    expect(Buffer.from(data.rawPayload).equals(TEST_PNG)).toBe(true);

    const del = await app.server.inject({ method: 'DELETE', url: '/api/admin/persona/references/front.png', headers: ADMIN });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { removedFile: boolean; referenceImages: string[] }).removedFile).toBe(true);
    expect(fs.existsSync(path.join(refsDir, 'front.png'))).toBe(false);
    const list = (await app.server.inject({ method: 'GET', url: '/api/admin/persona/references', headers: ADMIN })).json() as RefBody;
    expect(list.references.some((r) => r.name === 'front.png')).toBe(false);
  });

  it('伪装成 PNG 的可执行字节被拒绝，不落盘也不进名单', async () => {
    const { app, refsDir } = await withRefsDir();
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(2048, 0x90)]);
    const res = await app.server.inject({ method: 'POST', url: '/api/admin/persona/references', ...multipartFile('file', 'evil.png', elf, 'image/png') });
    expect(res.statusCode).toBe(415);
    expect(fs.readdirSync(refsDir)).toHaveLength(0);
    expect(app.config.getPersona().referenceImages).not.toContain('evil.png');
  });

  it('目录里已有但没启用的图会列出来，供面板启用/删除', async () => {
    const { app, refsDir } = await withRefsDir();
    fs.writeFileSync(path.join(refsDir, 'loose_full_body.png'), TEST_PNG);
    const list = (await app.server.inject({ method: 'GET', url: '/api/admin/persona/references', headers: ADMIN })).json() as RefBody;
    const loose = list.references.find((r) => r.name === 'loose_full_body.png');
    expect(loose).toMatchObject({ configured: false, exists: true, framing: 'full-body' });
  });

  it('往视角槽位上传会自动规范命名，并替换同视角旧图、保留其他视角', async () => {
    const { app, refsDir } = await withRefsDir();
    // 内置 persona 默认带 01/02/03 三张；先再铺一张侧脸，验证同视角会被一起替换
    await app.server.inject({ method: 'POST', url: '/api/admin/persona/references', ...multipartFile('file', 'old_side.png', TEST_PNG, 'image/png') });

    const front = await app.server.inject({ method: 'POST', url: '/api/admin/persona/references/slot/front', ...multipartFile('file', 'whatever.png', TEST_PNG, 'image/png') });
    expect(front.statusCode).toBe(200);
    const frontBody = front.json() as { reference: { name: string }; replaced: string[] };
    expect(frontBody.reference.name).toBe('ref_front.png');
    expect(frontBody.replaced).toEqual(['01_main_reference_front_half.png']);

    const res = await app.server.inject({ method: 'POST', url: '/api/admin/persona/references/slot/side', ...multipartFile('file', 'IMG_2031.jpg', TEST_PNG, 'image/jpeg') });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reference: { name: string; framing: string }; replaced: string[]; referenceImages: string[] };
    // 字节是 PNG，扩展名以嗅探结果为准，不受声明的 image/jpeg 影响
    expect(body.reference.name).toBe('ref_side.png');
    expect(body.reference.framing).toBe('side');
    expect(body.replaced).toEqual(['03_reference_side_profile.png', 'old_side.png']);
    // 全身视角不受影响，正/侧都换成规范名
    expect(body.referenceImages).toContain('02_reference_full_body_standing.png');
    expect(body.referenceImages).toContain('ref_front.png');
    expect(body.referenceImages).not.toContain('old_side.png');
    expect(fs.existsSync(path.join(refsDir, 'ref_side.png'))).toBe(true);
    expect(fs.existsSync(path.join(refsDir, 'ref_front.png'))).toBe(true);
  });

  it('槽位视角不合法时 400，且无令牌 401', async () => {
    const { app } = await withRefsDir();
    const bad = await app.server.inject({ method: 'POST', url: '/api/admin/persona/references/slot/diagonal', ...multipartFile('file', 'x.png', TEST_PNG, 'image/png') });
    expect(bad.statusCode).toBe(400);
    const noAuth = await app.server.inject({ method: 'POST', url: '/api/admin/persona/references/slot/side', headers: { 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--\r\n' });
    expect(noAuth.statusCode).toBe(401);
  });

  it('拒绝非法文件名与路径穿越，且无管理令牌一律 401', async () => {
    const { app } = await withRefsDir();
    const traversal = await app.server.inject({ method: 'GET', url: '/api/admin/persona/references/..%2F..%2Fetc%2Fpasswd/data', headers: ADMIN });
    expect([400, 404]).toContain(traversal.statusCode);
    const badName = await app.server.inject({ method: 'DELETE', url: '/api/admin/persona/references/a%20b.png', headers: ADMIN });
    expect(badName.statusCode).toBe(400);
    for (const url of ['/api/admin/persona/references', '/api/admin/persona/references/x.png/data']) {
      const res = await app.server.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});
