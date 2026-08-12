import type {
  LifeEventRow,
  LifeLogRow,
  LifePanelData,
  LifePlanRow,
  LifeSettings,
  ProactiveAttempt
} from './features.js';

const LIFE_KIND_LABELS: Record<string, string> = {
  chore: '家务',
  out: '出门',
  play: '玩耍',
  meal: '吃饭',
  rest: '休息',
  sleep: '睡觉',
  study: '学习',
  work: '工作',
  wake: '起床',
  wind_down: '睡前放松',
  reading: '阅读',
  task: '任务'
};

const LIFE_PLAN_STATUS_TEXT: Record<string, string> = {
  planned: '可能',
  active: '正在进行',
  paused: '暂时搁置',
  completed: '已经完成',
  cancelled: '已经放下',
  skipped: '没有去做'
};

export function lifeKindLabel(value: string): string {
  return LIFE_KIND_LABELS[value] ?? value;
}

export function lifePlanStatusText(value: string): string {
  return LIFE_PLAN_STATUS_TEXT[value] ?? value;
}

function safeTimeKey(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    if (!value?.trim()) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function compareTimeKeys(left: number | null, right: number | null, direction: 'ascending' | 'descending'): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return direction === 'ascending' ? left - right : right - left;
}

export function previewPlans(plans: LifePlanRow[]): LifePlanRow[] {
  return plans
    .filter(({ status }) => status === 'active' || status === 'planned' || status === 'paused')
    .sort((left, right) => {
      const leftTime = safeTimeKey(left.planned_start, left.created_at);
      const rightTime = safeTimeKey(right.planned_start, right.created_at);
      const validTimeOrder = compareTimeKeys(leftTime, rightTime, 'ascending');
      if ((leftTime === null) !== (rightTime === null)) return validTimeOrder;
      const activeOrder = Number(right.status === 'active') - Number(left.status === 'active');
      if (activeOrder !== 0) return activeOrder;
      if (left.priority !== right.priority) return right.priority - left.priority;
      return validTimeOrder;
    })
    .slice(0, 3);
}

export type LifeHistoryItem =
  | { kind: 'activity'; id: string; at: string; title: string; detail: string }
  | { kind: 'event'; id: string; at: string; title: string; detail: string }
  | { kind: 'proactive'; id: string; at: string; title: string; detail: string };

export function mergeLifeHistory(
  log: LifeLogRow[],
  events: LifeEventRow[],
  proactive: ProactiveAttempt[]
): LifeHistoryItem[] {
  const items: LifeHistoryItem[] = [
    ...log.map((row): LifeHistoryItem => ({
      kind: 'activity',
      id: row.id,
      at: row.ended_at,
      title: row.activity,
      detail: row.shared ? '已经分享' : row.mood
    })),
    ...events.map((event): LifeHistoryItem => ({
      kind: 'event',
      id: event.id,
      at: event.happened_at,
      title: event.description,
      detail: lifeKindLabel(event.kind)
    })),
    ...proactive.map((attempt): LifeHistoryItem => ({
      kind: 'proactive',
      id: attempt.id,
      at: attempt.createdAt,
      title: attempt.candidateActivity ?? '动态发布尝试',
      detail: attempt.status === 'sent'
        ? '已发布动态'
        : attempt.status === 'blocked'
          ? '暂未发布'
          : '发布失败'
    }))
  ];

  return items.sort((left, right) => compareTimeKeys(safeTimeKey(left.at), safeTimeKey(right.at), 'descending'));
}

export function contactBoundaryPayload(settings: LifeSettings): Partial<LifePanelData['settings']> {
  return {
    reachOut: settings.reachOut,
    quietGapMinutes: settings.quietGapMinutes,
    maxReachOutsPerDay: settings.maxReachOutsPerDay,
    silentFrom: settings.silentFrom,
    silentTo: settings.silentTo,
    proactiveMode: settings.proactiveMode ?? 'auto'
  };
}
