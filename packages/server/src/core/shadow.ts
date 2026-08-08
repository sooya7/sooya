import type { ShadowRepo, ExperimentRepo, ExperimentRow, AssignmentScope } from '../db/repos/shadow.repo.js';
import { createHash } from 'node:crypto';
import { localDateOfIso } from '../util/time-zone.js';
import { buildHistory, buildReport, type ExperimentHistoryEntry, type ExperimentReport, type MetricsAggregateReader } from './experiment-report.js';

/**
 * Shadow + Experiment runtime (next phase P3, 完整版).
 *
 * Shadow is architecturally read-only: the shadow function only receives a
 * plain input object (ids/kinds/numbers — never free text) and returns a
 * decision; it has no access to any repo, so it cannot write state, trigger
 * memory/proactive/push/media or affect the canonical path. Canonical always
 * runs first and is never influenced by the shadow.
 *
 * Experiments are single-user: assignment is sticky per scope (day/session/
 * conversation) so a variant never flips mid-scope, and a running experiment
 * must first pass through shadow.
 *
 * Canonical 隔离（§11 必修）：canonicalVariantFor / variantFor（旧名）
 * 在 status=shadow 时永远返回 'control'（实验未 promote 前 canonical 决策
 * 与无实验完全一致）；shadow 采样必须走 shadowVariantFor 才能拿到实验变体。
 */
export interface ShadowInput {
  subsystem: string;
  canonicalVersion: string;
  shadowVersion: string;
  /** Anonymized fingerprint — ids/kinds/numbers only. */
  input: Record<string, unknown>;
  canonicalDecision: unknown;
  runShadow: () => unknown;
}

export class ShadowService {
  private enabled = false;

  constructor(private readonly repo: ShadowRepo) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Runs the shadow candidate and records the diff. Never throws upward. */
  run(input: ShadowInput): void {
    if (!this.enabled) return;
    try {
      const started = Date.now();
      const shadowDecision = input.runShadow();
      const durationMs = Date.now() - started;
      const canonical = JSON.stringify(input.canonicalDecision ?? null);
      const shadow = JSON.stringify(shadowDecision ?? null);
      this.repo.recordRun({
        subsystem: input.subsystem,
        canonical_version: input.canonicalVersion,
        shadow_version: input.shadowVersion,
        input_fingerprint: fingerprint(input.input),
        canonical_decision: canonical,
        shadow_decision: shadow,
        diff_json: JSON.stringify({ equal: canonical === shadow }),
        duration_ms: durationMs
      });
    } catch { /* a shadow failure must never touch the canonical path */ }
  }

  list(subsystem?: string, limit = 100) {
    return this.repo.list(subsystem, limit);
  }
}

export class ExperimentService {
  private enabled = false;

  constructor(
    private readonly repo: ExperimentRepo,
    private readonly clock: () => Date = () => new Date(),
    private readonly timeZone: string = 'Asia/Shanghai'
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  list() {
    return this.repo.list();
  }

  create(
    name: string,
    subsystem: string,
    variants: string[],
    assignmentScope: AssignmentScope = 'day',
    rolloutPercent = 100
  ): ExperimentRow {
    const experiment = this.repo.create({ name, subsystem, variants, assignmentScope, rolloutPercent });
    this.repo.recordEvent(experiment.id, 'control', 'created');
    return experiment;
  }

  /**
   * Transition guard: shadow → running only via start-shadow first.
   * 生命周期事件全部走 audit 语义（created/shadow/promoted/paused/resumed/completed）。
   */
  setStatus(id: string, status: string): { ok: boolean; error?: string; experiment?: ExperimentRow } {
    const experiment = this.repo.get(id);
    if (!experiment) return { ok: false, error: 'not_found' };
    if (status === 'running' && experiment.status === 'draft') {
      return { ok: false, error: 'shadow_prerequisite' };
    }
    if (status === 'shadow' && experiment.status === 'draft') {
      // 进入 shadow 采样：canonical 仍为 'control'。
      this.repo.recordEvent(experiment.id, 'control', 'shadow');
    }
    if (status === 'running' && experiment.status === 'shadow') {
      // Promote：记录 promote 后实验将服务的 canonical 变体（rollout 未命中则为 'control'）。
      const variant = this.variantInRollout(experiment);
      this.repo.recordEvent(experiment.id, variant, 'promoted');
    }
    if (status === 'paused') this.repo.recordEvent(experiment.id, 'control', 'paused');
    if (status === 'running' && experiment.status === 'paused') {
      // Resume：保持原 sticky 分配。
      const variant = this.variantInRollout(experiment);
      this.repo.recordEvent(experiment.id, variant, 'resumed');
    }
    if (status === 'completed' || status === 'cancelled') this.repo.recordEvent(experiment.id, 'control', status);
    return { ok: true, experiment: this.repo.setStatus(id, status as ExperimentRow['status']) };
  }

  /**
   * 配置变更（名称/变体/scope/rollout），记录 config_changed 审计事件。
   * 变体/rollout 变更后，已有 scope 分配保持不变（sticky 不破坏）。
   */
  updateConfig(
    id: string,
    patch: { name?: string; variants?: string[]; assignmentScope?: AssignmentScope; rolloutPercent?: number }
  ): { ok: boolean; error?: string; experiment?: ExperimentRow } {
    const before = this.repo.get(id);
    if (!before) return { ok: false, error: 'not_found' };
    const experiment = this.repo.updateConfig(id, patch);
    if (!experiment) return { ok: false, error: 'not_found' };
    const variant = this.canonicalVariantFor(id) ?? 'control';
    this.repo.recordEvent(id, variant, 'config_changed');
    return { ok: true, experiment };
  }

  /**
   * Canonical（规范决策）变体：
   * - status=shadow → 永远 'control'（实验未 promote，canonical 与无实验一致）；
   * - status=paused → 立即 'control'（暂停 = 即时回滚）；
   * - status=running → rollout bucket 命中则 sticky 变体，未命中 'control'；
   * - draft/completed/cancelled → null（无活动实验）。
   */
  canonicalVariantFor(id: string): string | null {
    if (!this.enabled) return null;
    const experiment = this.repo.get(id);
    if (!experiment) return null;
    if (experiment.status === 'shadow' || experiment.status === 'paused') return 'control';
    if (experiment.status !== 'running') return null;
    return this.variantInRollout(experiment);
  }

  /** 旧名兼容：canonical 语义（status=shadow 时返回 'control'）。 */
  variantFor(id: string): string | null {
    return this.canonicalVariantFor(id);
  }

  /**
   * Shadow 采样变体：仅 status=shadow 的实验返回实验变体（rollout bucket
   * 未命中时为 'control'，即采样 canonical 行为）；其他状态返回 null。
   */
  shadowVariantFor(id: string): string | null {
    if (!this.enabled) return null;
    const experiment = this.repo.get(id);
    if (!experiment) return null;
    if (experiment.status !== 'shadow') return null;
    return this.variantInRollout(experiment);
  }

  /**
   * Canonical 变体 for the first active experiment of a subsystem, or null.
   * status=shadow 时永远返回 'control'。
   */
  canonicalVariantForSubsystem(subsystem: string): string | null {
    if (!this.enabled) return null;
    // A paused experiment keeps subsystem ownership (returning 'control',
    // i.e. canonical behavior) until it is completed/cancelled.
    const experiment = this.repo.list().find((e) => e.subsystem === subsystem && (e.status === 'running' || e.status === 'shadow' || e.status === 'paused'));
    if (!experiment) return null;
    return this.canonicalVariantFor(experiment.id);
  }

  /** 旧名兼容 = canonical 语义（engine.ts 等消费点无需改动即可获得修复）。 */
  variantForSubsystem(subsystem: string): string | null {
    return this.canonicalVariantForSubsystem(subsystem);
  }

  /**
   * Shadow 采样变体 for a subsystem：取第一个 status=shadow 的实验，
   * rollout bucket 命中返回实验变体，未命中返回 'control'；无 shadow
   * 实验返回 null。
   */
  shadowVariantForSubsystem(subsystem: string): string | null {
    if (!this.enabled) return null;
    const experiment = this.repo.list().find((e) => e.subsystem === subsystem && e.status === 'shadow');
    if (!experiment) return null;
    return this.shadowVariantFor(experiment.id);
  }

  /** Scope key: day = 本地日历日期（LIFE_TIME_ZONE），session = 进程会话，conversation = 会话 id。 */
  private scopeKey(scope: AssignmentScope): string {
    if (scope === 'day') return localDateOfIso(this.clock().toISOString(), this.timeZone);
    if (scope === 'session') return 'session';
    return 'main';
  }

  /** running/shadow 状态下按 rollout bucket 决定变体；分配 sticky 持久化。 */
  private variantInRollout(experiment: ExperimentRow): string {
    const variants = this.repo.variants(experiment);
    if (variants.length === 0) return 'control';
    const key = this.scopeKey(experiment.assignment_scope);
    if (this.repo.rolloutBucket(experiment.id, key) >= experiment.rollout_percent) return 'control';
    return this.repo.variantFor(experiment.id, key, variants);
  }

  events(experimentId: string, limit = 100) {
    return this.repo.events(experimentId, limit);
  }

  /**
   * 实验报告：只写 observed difference（样本数/均值），无统计显著性。
   * metrics 读取器由调用方（admin 路由 / 测试）注入，避免服务间循环依赖。
   */
  report(id: string, metrics?: MetricsAggregateReader): ExperimentReport | null {
    if (!this.enabled) return null;
    const experiment = this.repo.get(id);
    if (!experiment) return null;
    return buildReport({
      experiment,
      assignments: this.repo.assignments(id),
      metrics: metrics ?? { aggregates: () => [] },
      now: this.clock(),
      timeZone: this.timeZone
    });
  }

  /** 实验历史：全生命周期 audit 事件（契约 §1.5 事件名）。 */
  history(id: string): ExperimentHistoryEntry[] {
    const experiment = this.repo.get(id);
    if (!experiment) return [];
    return buildHistory(id, this.repo.events(id, 500));
  }
}

/** Stable fingerprint of an anonymized input — never the input itself. */
export function fingerprint(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24);
}
