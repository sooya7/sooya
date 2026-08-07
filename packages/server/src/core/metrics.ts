import type { MetricsRepo, MetricAggregate, MetricDailyRow } from '../db/repos/metrics.repo.js';

/**
 * MetricsService (next phase P2): privacy-safe counters aggregated per day.
 * Only category/metric names and numeric values — never message text,
 * prompts or addresses. Recording is a no-op unless METRICS_DASHBOARD_ENABLED.
 */
export class MetricsService {
  private enabled = false;

  constructor(
    private readonly repo: MetricsRepo,
    private readonly clock: () => Date = () => new Date()
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Counts one occurrence (or a measured value) for a category/metric. */
  record(category: string, metric: string, value = 1): void {
    if (!this.enabled) return;
    try {
      this.repo.record(category, metric, value, this.clock());
    } catch { /* metrics must never take down the pipeline */ }
  }

  /** Aggregates over the last N days (inclusive). */
  aggregates(days = 7): MetricAggregate[] {
    if (!this.enabled) return [];
    const to = this.clock().toISOString().slice(0, 10);
    const from = new Date(this.clock().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    return this.repo.aggregates(from, to);
  }

  daily(days = 7): MetricDailyRow[] {
    if (!this.enabled) return [];
    const to = this.clock().toISOString().slice(0, 10);
    const from = new Date(this.clock().getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    return this.repo.daily(from, to);
  }
}
