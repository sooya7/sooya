import type {
  ExperimentAssignmentRow,
  ExperimentEventRow,
  ExperimentRow
} from '../db/repos/shadow.repo.js';
import { localDateOfIso, addDaysLocalDate } from '../util/time-zone.js';

/**
 * 实验报告（完整版 §12）。
 *
 * 统计语义（诚实原则）：
 * - samples/control/treatment 来自 experiment_assignments 的 sticky 分配行；
 * - observedDifference 只做“观察到的差异”描述：把实验窗口
 *   （created_at 所在本地日起 → 当前本地日）内与实验前等长基线窗口内的
 *   同分类指标均值做对比，只报告样本数/均值，绝不构造统计显著性（无 p 值）。
 */
export interface ExperimentReport {
  experimentId: string;
  name: string;
  samples: number;
  control: number;
  treatment: number;
  observedDifference: { metric: string; control: number; treatment: number }[];
}

/**
 * 历史事件（契约 §1.5）。'cancelled' 为超集扩展：v23 起 experiment_events
 * 就记录 cancelled 终止事件，history API 如实透传（由 Integration 决定
 * 是否冻结为契约子集）。
 */
export type ExperimentHistoryEvent =
  | 'created' | 'shadow' | 'promoted' | 'paused' | 'resumed' | 'completed' | 'config_changed'
  | 'cancelled';

export interface ExperimentHistoryEntry {
  id: string;
  experimentId: string;
  event: ExperimentHistoryEvent;
  variant: string;
  createdAt: string;
}

/** 原始事件名 → 契约事件名（v23 时代记录的 'started' 兼容映射为 'promoted'）。 */
const EVENT_NAME_MAP: Record<string, ExperimentHistoryEvent> = {
  created: 'created',
  shadow: 'shadow',
  started: 'promoted',
  promoted: 'promoted',
  paused: 'paused',
  resumed: 'resumed',
  completed: 'completed',
  config_changed: 'config_changed',
  cancelled: 'cancelled'
};

/** 从 experiment_events 构建契约形态的历史条目（保持原始时间序）。 */
export function buildHistory(experimentId: string, events: ExperimentEventRow[]): ExperimentHistoryEntry[] {
  return events.map((e) => ({
    id: e.id,
    experimentId,
    event: EVENT_NAME_MAP[e.event] ?? (e.event as ExperimentHistoryEvent),
    variant: e.variant,
    createdAt: e.created_at
  }));
}

/** 报告所需的 metrics 读取面：只暴露聚合，不暴露写入（MetricsRepo 结构满足它）。 */
export interface MetricsAggregateReader {
  aggregates(fromDate: string, toDate: string): Array<{ category: string; metric: string; sum: number; count: number }>;
}

export function buildReport(input: {
  experiment: ExperimentRow;
  assignments: ExperimentAssignmentRow[];
  metrics: MetricsAggregateReader;
  now: Date;
  timeZone: string;
}): ExperimentReport {
  const { experiment, assignments, metrics, now, timeZone } = input;
  const samples = assignments.length;
  const control = assignments.filter((a) => a.variant === 'control').length;
  const treatment = samples - control;

  const category = experiment.subsystem.split('.')[0] ?? experiment.subsystem;
  const windowFrom = localDateOfIso(experiment.created_at, timeZone);
  const windowTo = localDateOfIso(now.toISOString(), timeZone);
  const windowDays = daysBetween(windowFrom, windowTo);
  const baselineTo = addDaysLocalDate(windowFrom, -1);
  const baselineFrom = addDaysLocalDate(baselineTo, -(windowDays - 1));

  const byMetric = (rows: Array<{ category: string; metric: string; sum: number; count: number }>) => {
    const map = new Map<string, { sum: number; count: number }>();
    for (const row of rows) {
      if (row.category !== category || row.count <= 0) continue;
      map.set(row.metric, { sum: row.sum, count: row.count });
    }
    return map;
  };

  const baseline = byMetric(metrics.aggregates(baselineFrom, baselineTo));
  const window = byMetric(metrics.aggregates(windowFrom, windowTo));

  const observedDifference: ExperimentReport['observedDifference'] = [];
  for (const [metric, win] of [...window.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const base = baseline.get(metric);
    if (!base) continue;
    observedDifference.push({
      metric,
      control: base.sum / base.count,
      treatment: win.sum / win.count
    });
  }

  return {
    experimentId: experiment.id,
    name: experiment.name,
    samples,
    control,
    treatment,
    observedDifference
  };
}

/** 本地日期相差天数（from <= to 语义下的区间宽度）。 */
function daysBetween(from: string, to: string): number {
  return Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
}
