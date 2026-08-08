import type { DbLike } from '../handle.js';
import { nowIso } from '../../util/ids.js';

export interface MetricDailyRow {
  date: string;
  category: string;
  metric: string;
  sum_value: number;
  count: number;
  /** v21 时代的历史行可能为 NULL；新记录恒有值。 */
  min_value: number | null;
  max_value: number | null;
  last_updated: string;
}

export interface MetricAggregate {
  category: string;
  metric: string;
  sum: number;
  count: number;
  avg: number;
}

/**
 * 分布统计（完整版）：按 (category, metric) 聚合出 count/sum/min/max/mean
 * 与 p50/p95。分位数语义：值先四舍五入到 0.01 落入 `metric_distributions`
 * 的桶，p50/p95 = 累积计数首次到达 50%/95% 位置时的桶值（最近样本语义）。
 */
export interface MetricsDistribution {
  category: string;
  metric: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

/** 导出专用行：只有指标名与数值，绝不包含任何私人正文。 */
export interface MetricExportRow {
  date: string;
  category: string;
  metric: string;
  count: number;
  sum: number;
  min: number;
  max: number;
}

/**
 * Privacy-safe daily metrics. Only (category, metric, numeric sums/counts)
 * are stored — never message text, prompts or addresses.
 *
 * 日期键由上层服务按 LIFE_TIME_ZONE 本地日期传入（禁止 UTC 切日）；
 * repo 层只负责按给定 day 字符串写入/聚合。
 */
export class MetricsRepo {
  constructor(private readonly db: DbLike) {}

  record(category: string, metric: string, value: number, day: string): void {
    this.db.prepare(`
      INSERT INTO metric_daily(date, category, metric, sum_value, count, min_value, max_value, last_updated)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(date, category, metric) DO UPDATE SET
        sum_value = sum_value + excluded.sum_value,
        count = count + 1,
        min_value = MIN(COALESCE(min_value, excluded.min_value), excluded.min_value),
        max_value = MAX(COALESCE(max_value, excluded.max_value), excluded.max_value),
        last_updated = excluded.last_updated
    `).run(day, category, metric, value, value, value, nowIso());

    // 分位数采样直方图：值四舍五入到 0.01 后计数，桶数有界。
    const bucket = Math.round(value * 100) / 100;
    this.db.prepare(`
      INSERT INTO metric_distributions(date, category, metric, bucket, count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(date, category, metric, bucket) DO UPDATE SET count = count + 1
    `).run(day, category, metric, bucket);
  }

  /** Aggregates over a date range (inclusive, local ISO dates). */
  aggregates(fromDate: string, toDate: string): MetricAggregate[] {
    return this.db.prepare(`
      SELECT category, metric,
             SUM(sum_value) AS sum, SUM(count) AS count
      FROM metric_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY category, metric
      ORDER BY category, metric
    `).all(fromDate, toDate) as MetricAggregate[];
  }

  daily(fromDate: string, toDate: string): MetricDailyRow[] {
    return this.db.prepare(
      'SELECT * FROM metric_daily WHERE date BETWEEN ? AND ? ORDER BY date, category, metric'
    ).all(fromDate, toDate) as MetricDailyRow[];
  }

  categories(): string[] {
    return (this.db.prepare('SELECT DISTINCT category FROM metric_daily ORDER BY category').all() as Array<{ category: string }>)
      .map((row) => row.category);
  }

  /** 分布统计：跨日期合并 min/max/直方图后计算分位数。 */
  distributions(fromDate: string, toDate: string): MetricsDistribution[] {
    const aggregates = this.db.prepare(`
      SELECT category, metric,
             SUM(sum_value) AS sum, SUM(count) AS count,
             MIN(COALESCE(min_value, 0)) AS min,
             MAX(COALESCE(max_value, 0)) AS max
      FROM metric_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY category, metric
      ORDER BY category, metric
    `).all(fromDate, toDate) as Array<{ category: string; metric: string; sum: number; count: number; min: number; max: number }>;

    const histogram = this.db.prepare(`
      SELECT category, metric, bucket, SUM(count) AS count
      FROM metric_distributions
      WHERE date BETWEEN ? AND ?
      GROUP BY category, metric, bucket
      ORDER BY category, metric, bucket
    `).all(fromDate, toDate) as Array<{ category: string; metric: string; bucket: number; count: number }>;

    // 按 (category, metric) 组织直方图桶（已按 bucket 升序）。
    const byKey = new Map<string, Array<{ bucket: number; count: number }>>();
    for (const row of histogram) {
      const key = `${row.category}\u0000${row.metric}`;
      const list = byKey.get(key);
      if (list) list.push({ bucket: row.bucket, count: row.count });
      else byKey.set(key, [{ bucket: row.bucket, count: row.count }]);
    }

    return aggregates.map((row) => {
      const buckets = byKey.get(`${row.category}\u0000${row.metric}`) ?? [];
      const mean = row.count > 0 ? row.sum / row.count : 0;
      return {
        category: row.category,
        metric: row.metric,
        count: row.count,
        sum: row.sum,
        min: row.min,
        max: row.max,
        mean,
        p50: percentileAt(buckets, 0.5),
        p95: percentileAt(buckets, 0.95)
      };
    });
  }

  /** 导出行：显式投影，只含日期/指标名/数值。 */
  exportRows(fromDate: string, toDate: string): MetricExportRow[] {
    return this.db.prepare(`
      SELECT date, category, metric, sum_value AS sum, count,
             COALESCE(min_value, 0) AS min, COALESCE(max_value, 0) AS max
      FROM metric_daily
      WHERE date BETWEEN ? AND ?
      ORDER BY date, category, metric
    `).all(fromDate, toDate) as MetricExportRow[];
  }
}

/** 累积计数到达 q 位置时的桶值；无样本时回退 0。 */
function percentileAt(buckets: Array<{ bucket: number; count: number }>, q: number): number {
  const total = buckets.reduce((acc, b) => acc + b.count, 0);
  if (total <= 0) return 0;
  const target = total * q;
  let cumulative = 0;
  for (const { bucket, count } of buckets) {
    cumulative += count;
    if (cumulative >= target) return bucket;
  }
  return buckets[buckets.length - 1]!.bucket;
}
