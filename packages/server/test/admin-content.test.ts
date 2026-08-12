import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

const ADMIN = { 'x-admin-token': 'admin-test-token' };
let harness: Harness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

describe('admin content and Ombre observability', () => {
  it('returns a safe MCP overview and read-only memory status surfaces', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: ADMIN['x-admin-token'] } });

    const overview = await harness.app.server.inject({ method: 'GET', url: '/api/admin/mcp/servers', headers: ADMIN });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ configSource: expect.any(String), globalPolicy: expect.any(Object), memory: { backend: 'ombre' } });
    expect(JSON.stringify(overview.json())).not.toContain('inputSchema');

    const status = await harness.app.server.inject({ method: 'GET', url: '/api/admin/memory/status', headers: ADMIN });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ backend: 'ombre', connection: 'degraded' });

    const legacy = await harness.app.server.inject({ method: 'GET', url: '/api/admin/memory/legacy?limit=10', headers: ADMIN });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json()).toMatchObject({ readOnly: true, memories: expect.any(Array) });
  });

  it('reports media usage and blocks deletion while referenced', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: ADMIN['x-admin-token'] } });
    const media = harness.app.repos.media.create({ id: 'admin_media_ref', kind: 'image', relPath: 'admin_media_ref.png', mime: 'image/png', bytes: 1, sha256: 'admin_media_ref_sha', origin: 'upload' });
    harness.app.repos.messages.create({ role: 'user', parts: [{ type: 'image', mediaId: media.id, status: 'sent' }] });

    const list = await harness.app.server.inject({ method: 'GET', url: '/api/admin/media?limit=10', headers: ADMIN });
    expect(list.statusCode).toBe(200);
    expect(list.json().media.find((item: { id: string }) => item.id === media.id)).toMatchObject({ usageCount: 1 });

    const remove = await harness.app.server.inject({ method: 'DELETE', url: `/api/admin/media/${media.id}`, headers: ADMIN });
    expect(remove.statusCode).toBe(409);
    expect(remove.json()).toMatchObject({ error: 'media_in_use' });

    const trash = await harness.app.server.inject({ method: 'POST', url: `/api/admin/media/${media.id}/trash`, headers: ADMIN });
    expect(trash.statusCode).toBe(409);
    expect(trash.json()).toMatchObject({ error: 'media_in_use' });
  });

  it('filters stickers in SQL and returns facets for the gallery toolbar', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: ADMIN['x-admin-token'] } });
    const first = harness.app.repos.media.create({ id: 'sticker_media_one', kind: 'sticker', relPath: 'one.png', mime: 'image/png', bytes: 1, sha256: 'one', origin: 'upload' });
    const second = harness.app.repos.media.create({ id: 'sticker_media_two', kind: 'sticker', relPath: 'two.png', mime: 'image/png', bytes: 1, sha256: 'two', origin: 'upload' });
    harness.app.repos.stickers.create({ id: 'sticker_one', mediaId: first.id, name: '开心猫', emotion: '开心', analysisSource: 'manual', analysisStatus: 'ready' });
    harness.app.repos.stickers.create({ id: 'sticker_two', mediaId: second.id, name: '安静猫', emotion: '安静', analysisSource: 'ai', analysisStatus: 'pending' });

    const response = await harness.app.server.inject({ method: 'GET', url: '/api/admin/stickers?emotion=%E5%BC%80%E5%BF%83&source=manual&limit=1', headers: ADMIN });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 1, stickers: [{ id: 'sticker_one' }], facets: { status: expect.any(Object), source: expect.any(Object), emotion: expect.any(Object) } });
  });

  it('returns chat history without system or internal tool messages and supports context', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ADMIN_API_TOKEN: ADMIN['x-admin-token'] } });
    const user = harness.app.repos.messages.create({ role: 'user', parts: [{ type: 'text', text: 'admin history query' }] }).message;
    harness.app.repos.messages.create({ role: 'system', parts: [{ type: 'system', text: 'internal tool trace' }] });
    const response = await harness.app.server.inject({ method: 'GET', url: '/api/admin/chat/history?q=history&limit=10', headers: ADMIN });
    expect(response.statusCode).toBe(200);
    expect(response.json().messages.map((message: { id: string }) => message.id)).toContain(user.id);
    expect(response.json().messages.some((message: { role: string }) => message.role === 'system')).toBe(false);

    const context = await harness.app.server.inject({ method: 'GET', url: `/api/admin/chat/history/${user.id}/context?before=1&after=1`, headers: ADMIN });
    expect(context.statusCode).toBe(200);
    expect(context.json().messages.every((message: { role: string }) => message.role !== 'system')).toBe(true);
  });
});
