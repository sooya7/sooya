import type { DbLike } from '../handle.js';
import { nowIso } from '../../util/ids.js';

export interface MetricDailyRow {
  date: string;
  category: string;
  metric: string;
  sum_value: number;
  count: number;
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
 * Privacy-safe daily metrics. Only (category, metric, numeric sums/counts)
 * are stored — never message text, prompts or addresses.
 */
export class MetricsRepo {
  constructor(private readonly db: DbLike) {}

  record(category: string, metric: string, value: number, at: Date): void {
    const day = at.toISOString().slice(0, 10);
    this.db.prepare(`
      INSERT INTO metric_daily(date, category, metric, sum_value, count, last_updated)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(date, category, metric) DO UPDATE SET
        sum_value = sum_value + excluded.sum_value,
        count = count + 1,
        last_updated = excluded.last_updated
    `).run(day, category, metric, value, nowIso());
  }

  /** Aggregates over a date range (inclusive, ISO dates). */
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
}
