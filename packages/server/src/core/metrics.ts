import { localDateOfIso, addDaysLocalDate } from '../util/time-zone.js';
import type {
  MetricsRepo,
  MetricAggregate,
  MetricDailyRow,
  MetricsDistribution
} from '../db/repos/metrics.repo.js';

const DAY_MS = 86_400_000;

/**
 * MetricsService: privacy-safe counters aggregated
 * per LIFE_TIME_ZONE local day.
 *
 * - 本地日期归档：切日键由 timeZone（默认 'Asia/Shanghai'，Integration 从
 *   env.LIFE_TIME_ZONE 传入）计算，禁止 UTC 切日。
 * - 分布统计：min/max/mean/p50/p95 由 repo 的直方图聚合（见 metrics.repo.ts）。
 * Recording is a no-op unless METRICS_DASHBOARD_ENABLED.
 */
export class MetricsService {
  private enabled = false;

  constructor(
    private readonly repo: MetricsRepo,
    private readonly clock: () => Date = () => new Date(),
    private readonly timeZone: string = 'Asia/Shanghai'
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 本地日期（LIFE_TIME_ZONE）YYYY-MM-DD。 */
  localDay(at: Date): string {
    return localDateOfIso(at.toISOString(), this.timeZone);
  }

  /** 今天的本地日期（供路由层默认参数使用）。 */
  todayLocal(): string {
    return this.localDay(this.clock());
  }

  /** Counts one occurrence (or a measured value) for a category/metric. */
  record(category: string, metric: string, value = 1): void {
    if (!this.enabled) return;
    try {
      this.repo.record(category, metric, value, this.localDay(this.clock()));
    } catch { /* metrics must never take down the pipeline */ }
  }

  /** Aggregates over the last N days (inclusive, local days). */
  aggregates(days = 7): MetricAggregate[] {
    if (!this.enabled) return [];
    const { from, to } = this.dayRange(days);
    return this.repo.aggregates(from, to);
  }

  daily(days = 7): MetricDailyRow[] {
    if (!this.enabled) return [];
    const { from, to } = this.dayRange(days);
    return this.repo.daily(from, to);
  }

  /** 分布统计（含 p50/p95）over the last N days. */
  distributions(days = 7): MetricsDistribution[] {
    if (!this.enabled) return [];
    const { from, to } = this.dayRange(days);
    return this.repo.distributions(from, to);
  }

  /** 分布统计 over an explicit local-date range (inclusive). */
  distributionsBetween(fromDate: string, toDate: string): MetricsDistribution[] {
    if (!this.enabled) return [];
    return this.repo.distributions(fromDate, toDate);
  }

  private dayRange(days: number): { from: string; to: string } {
    const now = this.clock();
    const to = this.localDay(now);
    const from = this.localDay(new Date(now.getTime() - (days - 1) * DAY_MS));
    return { from, to };
  }
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
