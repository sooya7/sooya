import type { TravelMode, TravelStateRow } from '../../db/repos/location.repo.js';

/**
 * Travel 模型（Location 模块）。
 *
 * 防瞬移：活动解析只负责"出发"（写入 travel_state），到达由
 * `expectedArriveAt` 到期后的惰性结算完成（写 state + visit）。
 * 纯函数部分集中在这里，便于复用与测试。
 */

/** 冻结契约：TravelState（docs/NEXT-PHASE-CONTRACTS.md §1.1）。 */
export interface TravelState {
  fromLocationId: string;
  toLocationId: string;
  mode: TravelMode;
  startedAt: string;
  expectedArriveAt: string; // 禁止瞬移：到达后写 state + visit
  /** 溯源（可选内部字段）：到达时写入 state/visit 的来源。 */
  sourcePlanId?: string | null;
  sourceActivityId?: string | null;
}

/** 图里查不到边时的兜底行程时长（分钟），按步行估。 */
export const DEFAULT_TRAVEL_MINUTES = 15;

export function toTravelState(row: TravelStateRow): TravelState {
  return {
    fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id,
    mode: row.mode,
    startedAt: row.started_at,
    expectedArriveAt: row.expected_arrive_at,
    sourcePlanId: row.source_plan_id,
    sourceActivityId: row.source_activity_id
  };
}

/** 行程是否已到期（now >= expectedArriveAt）。 */
export function travelDueAt(travel: TravelState, now: Date): boolean {
  return now.getTime() >= Date.parse(travel.expectedArriveAt);
}

/** 剩余行程分钟数（至少 1，用于提示语）。 */
export function travelRemainingMinutes(travel: TravelState, now: Date): number {
  const remainMs = Date.parse(travel.expectedArriveAt) - now.getTime();
  return Math.max(1, Math.round(remainMs / 60_000));
}

/** 行程方式的中文标签。 */
export const MODE_LABELS: Record<TravelMode, string> = {
  walk: '步行',
  bike: '骑车',
  transit: '坐车',
  car: '开车',
  unknown: '出发'
};
