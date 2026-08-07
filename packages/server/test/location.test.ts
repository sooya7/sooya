import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

/**
 * P0 location model: the location service is inert when the flag is off, seeds
 * builtin locations when enabled, moves SOOYA on activity resolution, applies
 * anti-repeat, persists across restart, and every admin mutation is audited.
 */
describe('location model (P0)', () => {
  it('is completely inert when LOCATION_MODEL_ENABLED=false', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false });
    expect(harness.app.services.location.isEnabled).toBe(false);
    expect(harness.app.services.location.current()).toBeNull();
    expect(harness.app.services.location.list()).toEqual([]);
    // The life engine context does not mention any location.
    expect(harness.app.services.location.contextLines()).toEqual([]);
  });

  it('seeds builtin locations and moves on activity resolution when enabled', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    expect(harness.app.services.location.isEnabled).toBe(true);
    const locations = harness.app.services.location.list();
    expect(locations.length).toBeGreaterThanOrEqual(6);
    expect(locations.some((l) => l.kind === 'home')).toBe(true);

    // Resolving an out/cafe-ish activity moves her.
    const cafe = locations.find((l) => l.kind === 'cafe')!;
    const result = harness.app.services.location.onActivityResolved(
      { id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never,
      'out',
      'plan_1',
      'cafe-activity'
    );
    expect(result?.locationId).toBe(cafe.id);
    const current = harness.app.services.location.current();
    expect(current?.id).toBe(cafe.id);
    const state = harness.app.services.location.currentState();
    expect(state?.source_plan_id).toBe('plan_1');
  });

  it('applies anti-repeat: a recently visited location loses the tie', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const locations = harness.app.services.location.list();
    const park = locations.find((l) => l.kind === 'park')!;
    // Visit the park, then resolve another park activity shortly after.
    harness.app.repos.locations.recordVisit({ locationId: park.id, enteredAt: new Date().toISOString() });
    harness.app.services.location.onActivityResolved({ id: 'walk', kind: 'out', locationAffinity: ['park'] } as never, 'out', null, 'walk-activity');
    const current = harness.app.services.location.current();
    // The park was just visited; the selector should prefer something else.
    expect(current?.id).not.toBe(park.id);
  });

  it('survives a restart without drifting', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const dataDir = harness.app.env.dataDir;
    const locations = harness.app.services.location.list();
    const cafe = locations.find((l) => l.kind === 'cafe')!;
    harness.app.services.location.onActivityResolved({ id: 'cafe', kind: 'out', locationAffinity: ['cafe'] } as never, 'out', null, null);
    await harness.app.close();
    harness = null;

    const second = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', DATA_DIR: dataDir },
      clock: () => localTime('2026-08-08T11:00')
    });
    harness = second;
    const current = second.app.services.location.current();
    expect(current?.id).toBe(cafe.id);
  });

  it('admin CRUD and override are audited', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', ADMIN_API_TOKEN: 'admin-test-token' }
    });
    const created = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/life/locations',
      headers: { 'x-admin-token': 'admin-test-token' },
      payload: { name: '屋顶花园', kind: 'outdoor', tags: ['garden', 'quiet'] }
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as { location: { id: string } };

    const override = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/life/location/override',
      headers: { 'x-admin-token': 'admin-test-token' },
      payload: { locationId: body.location.id, reason: '测试覆盖' }
    });
    expect(override.statusCode).toBe(200);
    expect(harness.app.services.location.current()?.id).toBe(body.location.id);

    const audit = harness.app.repos.audit.list(10) as Array<{ category: string; action: string }>;
    expect(audit.some((a) => a.category === 'life.location' && a.action === 'override')).toBe(true);
    expect(audit.some((a) => a.category === 'life.location' && a.action === 'create')).toBe(true);
  });

  it('GET /api/life/locations exposes the known locations without inventing details', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const res = await harness.app.server.inject({ method: 'GET', url: '/api/life/locations' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { locations: Array<{ name: string; kind: string }>; current: unknown };
    expect(body.locations.length).toBeGreaterThanOrEqual(6);
    expect(body.current).toBeNull();
  });
});
