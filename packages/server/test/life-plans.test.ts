import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

const ADMIN = { 'x-admin-token': 'admin-test-token' };
let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('life engine 2 plans and events', () => {
  it('persists a plan through status changes and exposes it in the admin panel', async () => {
    harness = await createHarness({
      env: { ADMIN_API_TOKEN: 'admin-test-token', ENABLE_LIFE_ENGINE: 'true', ENABLE_BACKGROUND_JOBS: 'false' },
      startWorkers: false
    });

    const created = await harness.app.server.inject({
      method: 'POST', url: '/api/admin/life/plans', headers: ADMIN,
      payload: { title: '整理书桌', kind: 'chore' }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().plan).toMatchObject({ title: '整理书桌', kind: 'chore', status: 'planned', source: 'admin' });

    const id = created.json().plan.id as string;
    const activated = await harness.app.server.inject({
      method: 'PATCH', url: `/api/admin/life/plans/${id}`, headers: ADMIN,
      payload: { status: 'active' }
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().plan.status).toBe('active');

    const panel = await harness.app.server.inject({ method: 'GET', url: '/api/admin/life', headers: ADMIN });
    expect(panel.statusCode).toBe(200);
    expect(panel.json().plans).toEqual(expect.arrayContaining([expect.objectContaining({ id, status: 'active' })]));
    expect(panel.json().events).toEqual([]);
  });

  it('records one shareable completed event at a life boundary and does not duplicate an idempotent tick', async () => {
    let now = new Date('2026-07-31T17:30:00+08:00');
    harness = await createHarness({
      env: { ADMIN_API_TOKEN: 'admin-test-token', ENABLE_LIFE_ENGINE: 'true', ENABLE_LIFE_REACH_OUT: 'true', ENABLE_BACKGROUND_JOBS: 'false' },
      startWorkers: false,
      clock: () => now
    });

    expect(harness.app.services.life.tick().changed).toBe(true);
    expect(harness.app.services.life.tick().changed).toBe(false);
    now = new Date('2026-07-31T18:30:00+08:00');
    expect(harness.app.services.life.tick().changed).toBe(true);

    const events = harness.app.repos.life.events();
    expect(events).toHaveLength(1);
    // V2 records exactly one rich boundary event (activity.finished) and keeps
    // the kind-based shareability floor.
    expect(events[0]).toMatchObject({ event_type: 'activity.finished', shareable: 1 });
    expect(harness.app.repos.life.events()).toHaveLength(1);

    const decision = harness.app.services.life.shouldReachOut(null, null);
    expect(decision).toMatchObject({ reach: true });
    expect(decision.candidate).toBeTruthy();
    harness.app.services.life.markShared(events[0]!.id);
    expect(harness.app.services.life.shouldReachOut(null, null).reason).toBe('nothing_worth_saying');
    expect(harness.app.repos.life.events()[0]!.shared_at).toBeTruthy();
  });

  it('keeps plan routes behind the admin guard', async () => {
    harness = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token', ENABLE_BACKGROUND_JOBS: 'false' }, startWorkers: false });
    const create = await harness.app.server.inject({ method: 'POST', url: '/api/admin/life/plans', payload: { title: 'x', kind: 'chore' } });
    const update = await harness.app.server.inject({ method: 'PATCH', url: '/api/admin/life/plans/abc', payload: { status: 'active' } });
    expect(create.statusCode).toBe(401);
    expect(update.statusCode).toBe(401);
  });
});
