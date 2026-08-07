import { localDateOfIso, addDaysLocalDate } from '../util/time-zone.js';
import type {
  MetricsRepo,
  MetricAggregate,
  MetricDailyRow,
  MetricsDistribution,
  MetricExportRow
} from '../db/repos/metrics.repo.js';

/**
 * 版本对比（完整版）：当前窗口与前一窗口的聚合指标集合。
 * current/previous 均为 { from, to, aggregates }，from/to 为本地日期。
 */
export interface ReleaseMetricsComparison {
  current: { from: string; to: string; aggregates: MetricAggregate[] };
  previous: { from: string; to: string; aggregates: MetricAggregate[] };
}

const DAY_MS = 86_400_000;

/**
 * MetricsService (next phase P2, 完整版): privacy-safe counters aggregated
 * per LIFE_TIME_ZONE local day.
 *
 * - 本地日期归档：切日键由 timeZone（默认 'Asia/Shanghai'，Integration 从
 *   env.LIFE_TIME_ZONE 传入）计算，禁止 UTC 切日。
 * - 分布统计：min/max/mean/p50/p95 由 repo 的直方图聚合（见 metrics.repo.ts）。
 * - 版本对比：releaseComparison* 返回两个窗口的聚合。
 * - 导出：CSV/JSON 只含指标名与数值，绝不含私人正文。
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

  /** 版本对比：两个显式本地日期窗口的聚合。 */
  releaseComparison(
    currentFrom: string,
    currentTo: string,
    previousFrom: string,
    previousTo: string
  ): ReleaseMetricsComparison {
    if (!this.enabled) {
      return {
        current: { from: currentFrom, to: currentTo, aggregates: [] },
        previous: { from: previousFrom, to: previousTo, aggregates: [] }
      };
    }
    return {
      current: { from: currentFrom, to: currentTo, aggregates: this.repo.aggregates(currentFrom, currentTo) },
      previous: { from: previousFrom, to: previousTo, aggregates: this.repo.aggregates(previousFrom, previousTo) }
    };
  }

  /** 版本对比：以“最近 currentDays 天”为当前窗口、“其前 previousDays 天”为基线窗口。 */
  releaseComparisonDays(currentDays = 7, previousDays = 7): ReleaseMetricsComparison {
    if (!this.enabled) {
      return { current: { from: '', to: '', aggregates: [] }, previous: { from: '', to: '', aggregates: [] } };
    }
    const to = this.todayLocal();
    const currentFrom = this.localDay(new Date(this.clock().getTime() - (currentDays - 1) * DAY_MS));
    const previousTo = addDaysLocalDate(currentFrom, -1);
    const previousFrom = addDaysLocalDate(previousTo, -(previousDays - 1));
    return this.releaseComparison(currentFrom, to, previousFrom, previousTo);
  }

  /** 导出行（最近 N 天）。 */
  exportRows(days = 7): MetricExportRow[] {
    if (!this.enabled) return [];
    const { from, to } = this.dayRange(days);
    return this.repo.exportRows(from, to);
  }

  /** CSV 序列化（日期/分类/指标名可能含逗号或引号，做标准转义）。 */
  toCsv(rows: MetricExportRow[]): string {
    const header = ['date', 'category', 'metric', 'count', 'sum', 'min', 'max'];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push([
        csvField(row.date),
        csvField(row.category),
        csvField(row.metric),
        row.count,
        row.sum,
        row.min,
        row.max
      ].join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  /** JSON 导出（数组，仅指标行）。 */
  toJson(rows: MetricExportRow[]): string {
    return JSON.stringify(rows, null, 2);
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
