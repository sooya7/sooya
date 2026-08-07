import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { localDateOfIso, addDaysLocalDate } from '../src/util/time-zone.js';

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
    expect(kinds).toContain('created');
    expect(kinds).toContain('shadow');
    expect(kinds).toContain('promoted');
    expect(kinds).toContain('paused');
    // The promotion assigned a variant and recorded it.
    const promoted = events.find((e) => e.event === 'promoted')!;
    expect(['x1', 'x1.5']).toContain(promoted.variant);
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
    expect(kinds).toEqual(expect.arrayContaining(['promoted', 'paused', 'completed']));

    const list = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/experiments',
      headers: { 'x-admin-token': 'exp-test-token' }
    });
    expect(list.statusCode).toBe(200);
    const rows = (list.json() as { experiments: Array<{ name: string; status: string }> }).experiments;
    expect(rows.some((e) => e.name === 'API 实验' && e.status === 'completed')).toBe(true);
  });

  it('rollout uses a deterministic sticky bucket, not per-message randomness', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: EXP_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    const experiments = harness.app.services.experiments;
    const exp = experiments.create('连续性权重', 'life.continuity_weight', ['x1', 'x1.5'], 'day', 10);
    experiments.setStatus(exp.id, 'shadow');
    experiments.setStatus(exp.id, 'running');

    // 桶值只由 (scopeKey, experimentId) 决定，可复现。
    const bucket = harness.app.repos.experiments.rolloutBucket(exp.id, '2026-08-08');
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(harness.app.repos.experiments.rolloutBucket(exp.id, '2026-08-08')).toBe(bucket);

    // 单次确定性计算即可推断结果（10% 命中与否由桶决定），且重复读取 sticky。
    const first = experiments.variantFor(exp.id);
    expect(experiments.variantFor(exp.id)).toBe(first);
    if (bucket < 10) expect(['x1', 'x1.5']).toContain(first);
    else expect(first).toBe('control');
  });

  it('rollout gates shadow sampling only while status=shadow; canonical stays control', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: EXP_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    const experiments = harness.app.services.experiments;
    const exp = experiments.create('连续性权重', 'life.continuity_weight', ['x1', 'x1.5'], 'day', 10);
    experiments.setStatus(exp.id, 'shadow');

    const bucket = harness.app.repos.experiments.rolloutBucket(exp.id, '2026-08-08');
    const sampled = experiments.shadowVariantFor(exp.id);
    if (bucket < 10) expect(['x1', 'x1.5']).toContain(sampled);
    else expect(sampled).toBe('control');
    // shadow 状态下 canonical 永远是 control，rollout 不影响 canonical。
    expect(experiments.canonicalVariantFor(exp.id)).toBe('control');
    expect(experiments.canonicalVariantForSubsystem('life.continuity_weight')).toBe('control');

    // promote 后 canonical 由同一桶决定（确定性，非每条消息随机）。
    experiments.setStatus(exp.id, 'running');
    const canonical = experiments.variantFor(exp.id);
    if (bucket < 10) expect(['x1', 'x1.5']).toContain(canonical);
    else expect(canonical).toBe('control');
  });

  it('rolloutPercent=100 always enters the experiment group', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: EXP_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    const experiments = harness.app.services.experiments;
    const exp = experiments.create('连续性权重', 'life.continuity_weight', ['x1', 'x1.5'], 'day', 100);
    experiments.setStatus(exp.id, 'shadow');
    experiments.setStatus(exp.id, 'running');
    expect(['x1', 'x1.5']).toContain(experiments.variantFor(exp.id));
  });

  it('updateConfig records config_changed and keeps existing scope assignments', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: EXP_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    const experiments = harness.app.services.experiments;
    const exp = experiments.create('连续性权重', 'life.continuity_weight', ['x1', 'x1.5'], 'day', 100);
    experiments.setStatus(exp.id, 'shadow');
    experiments.setStatus(exp.id, 'running');
    const first = experiments.variantFor(exp.id);
    expect(['x1', 'x1.5']).toContain(first);

    const cfg = experiments.updateConfig(exp.id, { rolloutPercent: 50 });
    expect(cfg.ok).toBe(true);
    expect(cfg.experiment!.rollout_percent).toBe(50);
    expect(experiments.events(exp.id).map((e) => e.event)).toContain('config_changed');

    // 已分配的 scope 保持 sticky：仍在实验组则原变体不变，掉出则 control。
    const bucket = harness.app.repos.experiments.rolloutBucket(exp.id, '2026-08-08');
    if (bucket < 50) expect(experiments.variantFor(exp.id)).toBe(first);
    else expect(experiments.variantFor(exp.id)).toBe('control');
  });

  it('builds a report with observed difference only — no invented significance', async () => {
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
    experiments.variantFor(created.id); // 1 条 day-scope 分配（rollout 100 → 实验组）

    // 用与 buildReport 相同的窗口算法写入基线/窗口指标（避免依赖真实时钟）。
    const now = new Date('2026-08-08T10:00:00+08:00');
    const windowFrom = localDateOfIso(created.created_at, 'Asia/Shanghai');
    const windowTo = localDateOfIso(now.toISOString(), 'Asia/Shanghai');
    const windowDays = Math.max(1, Math.round((Date.parse(`${windowTo}T00:00:00Z`) - Date.parse(`${windowFrom}T00:00:00Z`)) / 86_400_000) + 1);
    const baselineTo = addDaysLocalDate(windowFrom, -1);
    const baselineFrom = addDaysLocalDate(baselineTo, -(windowDays - 1));
    harness.app.repos.metrics.record('life', 'latency_ms', 100, baselineFrom);
    harness.app.repos.metrics.record('life', 'latency_ms', 100, baselineTo);
    harness.app.repos.metrics.record('life', 'latency_ms', 200, windowFrom);
    harness.app.repos.metrics.record('life', 'latency_ms', 200, windowTo);

    const report = experiments.report(created.id, harness.app.repos.metrics);
    expect(report).toBeTruthy();
    expect(report!.experimentId).toBe(created.id);
    expect(report!.name).toBe('连续性权重');
    expect(report!.samples).toBe(1);
    expect(report!.treatment).toBe(1);
    expect(report!.control).toBe(0);
    expect(report!.observedDifference).toContainEqual({ metric: 'latency_ms', control: 100, treatment: 200 });

    // 报告字段白名单：绝不携带 p 值/显著性。
    const serialized = JSON.stringify(report);
    expect(Object.keys(report!).sort()).toEqual(['control', 'experimentId', 'name', 'observedDifference', 'samples', 'treatment']);
    expect(serialized).not.toContain('pValue');
    expect(serialized).not.toContain('significant');
  });

  it('records the full lifecycle and maps history to contract events', async () => {
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
    experiments.setStatus(created.id, 'paused');
    experiments.setStatus(created.id, 'running'); // resumed
    experiments.updateConfig(created.id, { rolloutPercent: 50 });
    experiments.setStatus(created.id, 'completed');

    const history = experiments.history(created.id);
    const events = history.map((h) => h.event);
    expect(events).toEqual(expect.arrayContaining(['created', 'shadow', 'promoted', 'paused', 'resumed', 'config_changed', 'completed']));
    for (const entry of history) {
      expect(entry.id).toBeTruthy();
      expect(entry.experimentId).toBe(created.id);
      expect(entry.createdAt).toBeTruthy();
    }
    const promoted = history.find((h) => h.event === 'promoted')!;
    expect(['x1', 'x1.5']).toContain(promoted.variant);

    // v23 时代的 legacy 'started' 事件映射为 'promoted'。
    harness.app.repos.experiments.recordEvent(created.id, 'x1', 'started');
    expect(experiments.history(created.id).map((h) => h.event)).not.toContain('started');
  });

  it('exposes report/history/config through the admin API', async () => {
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: EXP_ENV,
      clock: () => localTime('2026-08-08T10:00')
    });
    const post = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/experiments',
      headers: { 'x-admin-token': 'exp-test-token' },
      payload: { name: 'API 报告实验', subsystem: 'life.continuity_weight', variants: ['x1', 'x1.5'], assignmentScope: 'day' }
    });
    const id = (post.json() as { experiment: { id: string } }).experiment.id;

    // 配置变更（config_changed 事件）。
    const patch = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/experiments/${id}`,
      headers: { 'x-admin-token': 'exp-test-token' },
      payload: { rolloutPercent: 25 }
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { experiment: { rollout_percent: number } }).experiment.rollout_percent).toBe(25);

    // 非法 rollout 被拒绝。
    const bad = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/experiments/${id}`,
      headers: { 'x-admin-token': 'exp-test-token' },
      payload: { rolloutPercent: 33 }
    });
    expect(bad.statusCode).toBe(400);

    const shadow = await harness.app.server.inject({
      method: 'PATCH',
      url: `/api/admin/experiments/${id}`,
      headers: { 'x-admin-token': 'exp-test-token' },
      payload: { status: 'shadow' }
    });
    expect(shadow.statusCode).toBe(200);

    // 报告端点。
    const report = await harness.app.server.inject({
      method: 'GET',
      url: `/api/admin/experiments/${id}/report`,
      headers: { 'x-admin-token': 'exp-test-token' }
    });
    expect(report.statusCode).toBe(200);
    const reportBody = report.json() as { report: { experimentId: string; samples: number } };
    expect(reportBody.report.experimentId).toBe(id);

    // 历史端点。
    const history = await harness.app.server.inject({
      method: 'GET',
      url: `/api/admin/experiments/${id}/history`,
      headers: { 'x-admin-token': 'exp-test-token' }
    });
    expect(history.statusCode).toBe(200);
    const historyBody = history.json() as { history: Array<{ event: string }> };
    expect(historyBody.history.map((h) => h.event)).toEqual(expect.arrayContaining(['created', 'shadow', 'config_changed']));

    // 缺失 id → 404。
    const missing = await harness.app.server.inject({
      method: 'GET',
      url: '/api/admin/experiments/exp_missing/report',
      headers: { 'x-admin-token': 'exp-test-token' }
    });
    expect(missing.statusCode).toBe(404);
  });
});
