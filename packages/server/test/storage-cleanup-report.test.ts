import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

const ADMIN = { 'x-admin-token': 'admin-test-token' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function orphan(name: string, content: string): string {
  const target = path.join(harness!.app.env.mediaDir, name);
  fs.writeFileSync(target, content);
  return target;
}

async function preview() {
  const response = await harness!.app.server.inject({
    method: 'POST',
    url: '/api/admin/storage/cleanup',
    headers: ADMIN,
    payload: { apply: false, categories: ['orphanFiles'] }
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe('bound storage cleanup reports', () => {
  it('applies only the confirmed snapshot and leaves later orphan files untouched', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const confirmed = orphan('confirmed-orphan.bin', 'confirmed');
    const report = await preview();
    expect(report.report.reportId).toEqual(expect.any(String));
    const later = orphan('later-orphan.bin', 'later');

    const applied = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup',
      headers: ADMIN,
      payload: { apply: true, reportId: report.report.reportId, categories: ['orphanFiles'] }
    });

    expect(applied.statusCode).toBe(200);
    expect(fs.existsSync(confirmed)).toBe(false);
    expect(fs.existsSync(later)).toBe(true);
    expect(applied.json()).toMatchObject({
      applied: true,
      report: { reportId: report.report.reportId },
      deleted: { orphanFiles: 1 }
    });
    expect(harness.app.repos.audit.list().some((entry) =>
      entry.category === 'storage' &&
      entry.action === 'cleanup.applied' &&
      (entry.detail as { reportId?: string }).reportId === report.report.reportId
    )).toBe(true);
  });

  it('rejects apply without a confirmed report id', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup',
      headers: ADMIN,
      payload: { apply: true, categories: ['orphanFiles'] }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'cleanup_report_required' });
  });

  it('skips a confirmed file whose bytes changed after preview', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const changed = orphan('changed-after-preview.bin', 'before');
    const report = await preview();
    fs.appendFileSync(changed, '-after');

    const applied = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup',
      headers: ADMIN,
      payload: { apply: true, reportId: report.report.reportId, categories: ['orphanFiles'] }
    });

    expect(applied.statusCode).toBe(200);
    expect(fs.existsSync(changed)).toBe(true);
    expect(applied.json().skipped).toContainEqual({
      category: 'orphanFiles',
      target: changed,
      reason: 'file_changed_or_missing'
    });
  });

  it('skips media that became referenced after preview', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const media = await harness.app.services.mediaStore.save({
      kind: 'image',
      origin: 'upload',
      data: PNG,
      declaredMime: 'image/png',
      filename: 'referenced-after-preview.png'
    });
    harness.app.repos.media.trash(media.id);
    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup',
      headers: ADMIN,
      payload: { apply: false, categories: ['unreferencedMedia'] }
    });
    const report = response.json();
    expect(report.report.candidates.unreferencedMedia).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: media.id })])
    );
    harness.app.repos.messages.create({
      role: 'user',
      parts: [{ type: 'image', mediaId: media.id, status: 'sent' }]
    });

    const applied = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup',
      headers: ADMIN,
      payload: { apply: true, reportId: report.report.reportId, categories: ['unreferencedMedia'] }
    });

    expect(applied.statusCode).toBe(200);
    expect(harness.app.repos.media.get(media.id)).toBeTruthy();
    expect(applied.json().skipped).toContainEqual({
      category: 'unreferencedMedia',
      target: media.id,
      reason: 'no_longer_safe'
    });
  });

  it('counts only immediately deletable bytes and reconciles preview with apply', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const media = await harness.app.services.mediaStore.save({
      kind: 'image',
      origin: 'upload',
      data: PNG,
      declaredMime: 'image/png',
      filename: 'reclaimable.png'
    });

    const activePreview = await preview();
    expect(activePreview.report.candidates.unreferencedMedia).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: media.id })])
    );
    expect(activePreview.report.reclaimableBytes).toBe(0);

    harness.app.repos.media.trash(media.id);
    const trashPreviewResponse = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup',
      headers: ADMIN,
      payload: { apply: false, categories: ['unreferencedMedia'] }
    });
    const trashPreview = trashPreviewResponse.json();
    expect(trashPreview.report.candidates.unreferencedMedia).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: media.id, bytes: media.bytes })])
    );
    expect(trashPreview.report.reclaimableBytes).toBe(media.bytes);

    const applied = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/storage/cleanup',
      headers: ADMIN,
      payload: {
        apply: true,
        reportId: trashPreview.report.reportId,
        categories: ['unreferencedMedia']
      }
    });
    expect(applied.json()).toMatchObject({
      releasedBytes: media.bytes,
      deletedBytes: media.bytes,
      skippedBytes: 0,
      deleted: { unreferencedMedia: 1 }
    });
    expect(harness.app.repos.media.get(media.id)).toBeUndefined();
  });
});
