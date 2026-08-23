import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.cleanup();
  h = null;
});

const ADMIN_HEADERS = { 'x-admin-token': 'test-admin-token' };

describe('admin token rotation (§37)', () => {
  it('creates a token, overlaps with the env secret, then revokes cleanly', async () => {
    h = await createHarness({});
    const created = await h.app.server.inject({
      method: 'POST',
      url: '/api/admin/tokens',
      headers: ADMIN_HEADERS,
      payload: { label: 'laptop' }
    });
    expect(created.statusCode).toBe(200);
    const { token, view } = created.json() as { token: string; view: { id: string } };
    expect(token).toMatch(/^sooya_/);

    // Overlap window: both the env secret and the new token authenticate.
    const withNew = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/future/commitments',
      headers: { 'x-admin-token': token }
    });
    expect(withNew.statusCode).toBe(200);

    // Revoke: the token stops working, the env secret keeps working.
    const revoked = await h.app.server.inject({
      method: 'POST',
      url: `/api/admin/tokens/${view.id}/revoke`,
      headers: ADMIN_HEADERS
    });
    expect(revoked.json().ok).toBe(true);
    const afterRevoke = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/future/commitments',
      headers: { 'x-admin-token': token }
    });
    expect(afterRevoke.statusCode).toBe(401);
    const envStillWorks = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/future/commitments',
      headers: ADMIN_HEADERS
    });
    expect(envStillWorks.statusCode).toBe(200);

    // Metadata is visible for auditing; last_used_at was touched.
    const list = await h.app.server.inject({ method: 'GET', url: '/api/admin/tokens', headers: ADMIN_HEADERS });
    const tokens = list.json().tokens as Array<{ label: string; revokedAt: string | null; lastUsedAt: string | null }>;
    expect(tokens.some((t) => t.label === 'laptop' && t.revokedAt && t.lastUsedAt)).toBe(true);
  });

  it('rejects unknown tokens without leaking which part failed', async () => {
    h = await createHarness({});
    const res = await h.app.server.inject({
      method: 'GET',
      url: '/api/admin/tokens',
      headers: { 'x-admin-token': 'sooya_totally_wrong' }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('light rate limit (§38)', () => {
  it('lets normal traffic through and only trips runaway bursts', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'test-admin-token' } });
    // The admin prefix allows 240/min; a burst far beyond that must trip.
    let limited = 0;
    let first429: number | null = null;
    for (let i = 0; i < 260; i++) {
      const res = await h.app.server.inject({ method: 'GET', url: '/api/admin/tokens', headers: ADMIN_HEADERS });
      if (res.statusCode === 429) {
        limited++;
        if (first429 === null) first429 = i;
        expect(res.headers['retry-after']).toBeTruthy();
      }
    }
    expect(first429).toBe(240);
    expect(limited).toBe(20);
    // Health endpoint (outside the admin prefix) is unaffected.
    const health = await h.app.server.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBeLessThan(500);
  });
});

describe('backup integrity report (§36)', () => {
  it('reports missing referenced media, orphans and dangling refs without deleting', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'test-admin-token' } });
    // One media row whose file exists, one whose file vanished.
    const mediaStore = h.app.services.mediaStore;
    // A real 1x1 PNG so the media store's sniffing accepts it.
    const saved = await mediaStore.save({
      kind: 'image',
      origin: 'generated',
      data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
      declaredMime: 'image/png',
      filename: 'a.png'
    });
    expect(saved).toBeTruthy();
    const missing = h.app.db.raw
      .prepare("INSERT INTO media(id, kind, rel_path, mime, bytes, sha256, origin, created_at) VALUES ('ghost', 'image', 'images/ghost.png', 'image/png', 1, 'x', 'generated', '2026-08-21T00:00:00.000Z')")
      .run();
    expect(missing.changes).toBe(1);
    // An orphan file nothing references.
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.writeFile(path.join(h.app.env.mediaDir, 'images', 'orphan.png'), 'orphan');

    const report = await h.app.services.backups.integrityReport();
    // Seeded avatar/sticker rows point outside the test media dir; the ghost
    // row we planted must be among the missing references.
    expect(report.referencedMediaMissing).toContainEqual({ id: 'ghost', relPath: 'images/ghost.png' });
    expect(report.orphanFiles).toContain('images/orphan.png');
    // Report-only: the orphan is still on disk afterwards.
    expect(await fs.stat(path.join(h.app.env.mediaDir, 'images', 'orphan.png'))).toBeTruthy();
  });

  it('records WAL state and a per-file media manifest in the backup manifest', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'test-admin-token' } });
    const result = await h.app.services.backups.create('test-manifest');
    const fs = await import('node:fs/promises');
    const manifest = JSON.parse(await fs.readFile(`${result.path}.json`, 'utf8')) as {
      walMode: string;
      mediaManifest: Array<{ path: string }>;
      dbSha256: string;
    };
    expect(manifest.walMode).toBe('wal');
    expect(Array.isArray(manifest.mediaManifest)).toBe(true);
    expect(manifest.dbSha256).toHaveLength(64);
  });
});
