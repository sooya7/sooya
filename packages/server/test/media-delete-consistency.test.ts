import fsp from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

const ADMIN = { 'x-admin-token': 'admin-test-token' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let harness: Harness | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (harness) await harness.cleanup();
  harness = null;
});

describe('permanent media deletion consistency', () => {
  it('keeps the database record and returns a tracked failure when file removal fails', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const media = await harness.app.services.mediaStore.save({
      kind: 'image',
      origin: 'upload',
      data: PNG,
      declaredMime: 'image/png',
      filename: 'delete-failure.png'
    });
    const target = harness.app.services.mediaStore.absolutePath(media);
    vi.spyOn(fsp, 'rm').mockImplementation(async (path) => {
      if (path === target) throw new Error('simulated filesystem refusal');
    });

    const response = await harness.app.server.inject({
      method: 'DELETE',
      url: `/api/admin/media/${media.id}/permanent`,
      headers: ADMIN
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: 'media_delete_failed', deleted: false });
    expect(harness.app.repos.media.get(media.id)).toBeTruthy();
    expect(harness.app.services.mediaStore.exists(media)).toBe(true);
    expect(harness.app.repos.audit.list().some((entry) =>
      entry.category === 'media' && entry.action === 'permanent.delete_failed' && entry.target === media.id
    )).toBe(true);
  });

  it('reports batch failures without deleting failed records or blocking independent items', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const first = await harness.app.services.mediaStore.save({
      kind: 'image', origin: 'upload', data: PNG, declaredMime: 'image/png', filename: 'first.png'
    });
    const second = await harness.app.services.mediaStore.save({
      kind: 'image', origin: 'upload', data: PNG, declaredMime: 'image/png', filename: 'second.png'
    });
    const firstPath = harness.app.services.mediaStore.absolutePath(first);
    const originalRm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (target === firstPath) throw new Error('simulated batch refusal');
      await originalRm(target, options);
    });

    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/media/batch',
      headers: ADMIN,
      payload: { ids: [first.id, second.id], action: 'permanent' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      changed: 1,
      failed: [{ id: first.id, reason: 'delete_failed' }]
    });
    expect(harness.app.repos.media.get(first.id)).toBeTruthy();
    expect(harness.app.repos.media.get(second.id)).toBeUndefined();
  });

  it('does not remove an orphan database row when its file cannot be deleted', async () => {
    harness = await createHarness();
    const media = await harness.app.services.mediaStore.save({
      kind: 'image', origin: 'upload', data: PNG, declaredMime: 'image/png', filename: 'orphan.png'
    });
    const target = harness.app.services.mediaStore.absolutePath(media);
    vi.spyOn(fsp, 'rm').mockImplementation(async (path) => {
      if (path === target) throw new Error('simulated orphan refusal');
    });

    await expect(harness.app.services.mediaStore.collectOrphans(0))
      .rejects.toThrow('simulated orphan refusal');
    expect(harness.app.repos.media.get(media.id)).toBeTruthy();
    expect(harness.app.services.mediaStore.exists(media)).toBe(true);
  });
});
