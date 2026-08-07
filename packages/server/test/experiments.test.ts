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

const EXP_ENV = {
  EXPERIMENTS_ENABLED: 'true',
  WORLD_CONTEXT_ENABLED: 'true',
  LOCATION_MODEL_ENABLED: 'true',
  ENABLE_LIFE_ENGINE: 'true',
  ADMIN_API_TOKEN: 'exp-test-token'
};

/**
 * P3 experiments: draft cannot jump to running (shadow prerequisite),
 * day/session/conversation sticky assignment is deterministic per scope,
 * pause is an instant rollback to 'control', and every transition is
 * attributed in experiment_events.
 */
describe('experiments (P3)', () => {
  it('enforces the shadow prerequisite and records lifecycle events', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: EXP_ENV });
    const experiments = harness.app.services.experiments;

    const created = experiments.create('连续性权重', 'life.continuity_weight', ['x1', 'x1.5'], 'day');
    expect(created.status).toBe('draft');

    // Draft -> running is blocked: shadow sampling must come first.
    const blocked = experiments.setStatus(created.id, 'running');
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe('shadow_prerequisite');

    // The documented lifecycle works and is attributed.
    expect(experiments.setStatus(created.id, 'shadow').ok).toBe(true);
    expect(experiments.setStatus(created.id, 'running').ok).toBe(true);
    expect(experiments.setStatus(created.id, 'paused').ok).toBe(true);

    const events = experiments.events(created.id);
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain('started');
    expect(kinds).toContain('paused');
    // The promotion assigned a variant and recorded it.
    const started = events.find((e) => e.event === 'started')!;
    expect(['x1', 'x1.5']).toContain(started.variant);
  });

  it('assigns day-sticky variants deterministically and rolls back on pause', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: EXP_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    const experiments = harness.app.services.experiments;
    const created = experiments.create('连续性权重', 'life.continuity_weight', ['x1', 'x1.5'], 'day');
    experiments.setStatus(created.id, 'shadow');
    experiments.setStatus(created.id, 'running');

    const first = experiments.variantFor(created.id);
    expect(['x1', 'x1.5']).toContain(first);
    // Same day, repeated reads -> the same variant (sticky).
    expect(experiments.variantFor(created.id)).toBe(first);
    expect(experiments.variantForSubsystem('life.continuity_weight')).toBe(first);

    // Pause = instant rollback: everyone sees 'control', no assignment change.
    experiments.setStatus(created.id, 'paused');
    expect(experiments.variantFor(created.id)).toBe('control');
    expect(experiments.variantForSubsystem('life.continuity_weight')).toBe('control');

    // Resume keeps the same day assignment (sticky through pause).
    experiments.setStatus(created.id, 'running');
    expect(experiments.variantFor(created.id)).toBe(first);
  });

  it('session and conversation scopes stay sticky within their own key', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: EXP_ENV });
    const experiments = harness.app.services.experiments;

    const session = experiments.create('会话实验', 'life.anti_repeat_window', ['tighter-48', 'canonical-24'], 'session');
    experiments.setStatus(session.id, 'shadow');
    experiments.setStatus(session.id, 'running');
    expect(experiments.variantFor(session.id)).toBe(experiments.variantFor(session.id));

    const conversation = experiments.create('对话实验', 'life.anti_repeat_window', ['a', 'b'], 'conversation');
    experiments.setStatus(conversation.id, 'shadow');
    experiments.setStatus(conversation.id, 'running');
    expect(conversation.assignment_scope).toBe('conversation');
    expect(experiments.variantFor(conversation.id)).toBe(experiments.variantFor(conversation.id));
  });

  it('a second experiment on the same subsystem takes over attribution', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: EXP_ENV });
    const experiments = harness.app.services.experiments;

    const first = experiments.create('旧实验', 'life.anti_repeat_window', ['a', 'b'], 'day');
    experiments.setStatus(first.id, 'shadow');
    experiments.setStatus(first.id, 'running');
    const oldVariant = experiments.variantForSubsystem('life.anti_repeat_window');

    const second = experiments.create('新实验', 'life.anti_repeat_window', ['x', 'y'], 'day');
    experiments.setStatus(second.id, 'shadow');
    experiments.setStatus(second.id, 'running');
    const newVariant = experiments.variantForSubsystem('life.anti_repeat_window');
    expect(['x', 'y']).toContain(newVariant);
    expect(newVariant).not.toBe(oldVariant);
    // The old experiment still serves its own sticky variant.
    expect(experiments.variantFor(first.id)).toBe(oldVariant);
  });

  it('exposes the lifecycle through the admin API and keeps events', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: EXP_ENV });
    const post = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/experiments',
      headers: { 'x-admin-token': 'exp-test-token' },
      payload: { name: 'API 实验', subsystem: 'life.continuity_weight', variants: ['x1', 'x1.5'], assignmentScope: 'day' }
    });
    expect(post.statusCode).toBe(200);
    const created = post.json() as { experiment: { id: string; status: string } };
    expect(created.experiment.status).toBe('draft');

    const guard = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/experiments/${created.experiment.id}`,
      headers: { 'x-admin-token': 'exp-test-token' },
      payload: { status: 'running' }
    });
    expect(guard.statusCode).toBe(409);
    expect((guard.json() as { error: string }).error).toBe('shadow_prerequisite');

    for (const status of ['shadow', 'running', 'paused', 'completed']) {
      const res = await harness.app.server.inject({
        method: 'PATCH',
        url: `/api/admin/experiments/${created.experiment.id}`,
        headers: { 'x-admin-token': 'exp-test-token' },
        payload: { status }
      });
      expect(res.statusCode).toBe(200);
    }

    const events = await harness.app.server.inject({
      method: 'GET',
      url: `/api/admin/experiments/${created.experiment.id}/events`,
      headers: { 'x-admin-token': 'exp-test-token' }
    });
    expect(events.statusCode).toBe(200);
    const kinds = (events.json() as { events: Array<{ event: string }> }).events.map((e) => e.event);
    expect(kinds).toEqual(expect.arrayContaining(['started', 'paused', 'completed']));

    const list = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/experiments',
      headers: { 'x-admin-token': 'exp-test-token' }
    });
    expect(list.statusCode).toBe(200);
    const rows = (list.json() as { experiments: Array<{ name: string; status: string }> }).experiments;
    expect(rows.some((e) => e.name === 'API 实验' && e.status === 'completed')).toBe(true);
  });
});
