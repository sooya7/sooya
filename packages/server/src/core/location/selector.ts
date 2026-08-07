import type { LifeLocation, LifeLocationRow, LocationKind, TravelMode } from '../../db/repos/location.repo.js';
import type { LifeActivityDefinition } from '../life2/activities.js';

/**
 * LocationSelector (next phase): given the resolved activity, the current
 * location, recent visits and the clock, pick where SOOYA actually is. Pure
 * and deterministic (hash tie-break), so a replay cannot drift.
 */

export interface LocationSelectorInput {
  /** The activity library definition when the activity came from it. */
  def?: LifeActivityDefinition | null;
  /** Fallback kind for routine activities (home-ish by default). */
  kind: string;
  currentLocationId: string | null;
  /** Recently visited location ids (anti-repeat). */
  recentVisitIds: string[];
  /** Hours inside which a repeat visit is penalized. */
  repeatWindowHours: number;
  /** Related location tags from open threads. */
  threadTags: string[];
  hour: number;
  /** Optional weather condition modifier (see weather scoring). */
  weatherCondition?: string | null;
}

export interface LocationSelection {
  locationId: string;
  reason: string;
  travelMode: TravelMode;
  travelMinutes: number;
  scoreBreakdown: Record<string, number>;
}

/** Kind windows when a location is naturally open/usable (local hour). */
const KIND_WINDOWS: Partial<Record<LocationKind, [number, number]>> = {
  cafe: [7, 22],
  restaurant: [11, 22],
  store: [8, 22],
  park: [6, 21],
  library: [8, 21],
  mall: [10, 22],
  work: [9, 18],
  study: [8, 22]
};

/** Weather modifiers: location kind affinity per condition (P0-5). */
const WEATHER_MODIFIERS: Record<string, Partial<Record<LocationKind, number>>> = {
  rain: { park: -30, outdoor: -30, neighborhood: -15, cafe: 12, library: 12, home: 8, mall: 8, store: 5 },
  snow: { park: -25, outdoor: -25, home: 8, cafe: 8, library: 8, transit: -15 },
  storm: { park: -40, outdoor: -40, home: 15, library: 10, mall: 10, cafe: 10 },
  fog: { outdoor: -8, park: -8 },
  wind: { park: -10, outdoor: -10, cafe: 4, home: 4 },
  cloudy: { park: 5, outdoor: 5 },
  clear: { park: 15, outdoor: 15, neighborhood: 8 }
};

export function scoreLocationCandidates(
  candidates: LifeLocationRow[],
  input: LocationSelectorInput,
  travelLookup: (fromId: string, toId: string) => { travelMinutes: number; mode: TravelMode } | undefined,
  clockMs: number
): LocationSelection | null {
  const affinityKinds = input.def?.locationAffinity ?? [];
  const repeatCutoff = clockMs - input.repeatWindowHours * 3_600_000;
  let best: { row: LifeLocationRow; score: number; breakdown: Record<string, number>; travel: { travelMinutes: number; mode: TravelMode } | null | undefined } | null = null;

  for (const row of candidates) {
    const breakdown: Record<string, number> = {};
    let score = 0;

    // Compatibility: affinity kind exact match dominates.
    if (affinityKinds.length > 0) {
      if (affinityKinds.includes(row.kind)) {
        score += 40;
        breakdown.affinity = 40;
      } else if (row.kind === 'home' || row.kind === 'neighborhood') {
        score += 10;
        breakdown.affinity = 10;
      }
    } else if (row.kind === 'home' || row.kind === 'neighborhood') {
      // No affinity (routine/undefined): stay in the living area.
      score += 30;
      breakdown.affinity = 30;
    }

    // Time-of-day window.
    const window = KIND_WINDOWS[row.kind];
    if (window) {
      const inWindow = input.hour >= window[0] && input.hour < window[1];
      score += inWindow ? 8 : -15;
      breakdown.time = inWindow ? 8 : -15;
    }

    // Travel cost from the current location.
    const travel = input.currentLocationId && input.currentLocationId !== row.id
      ? travelLookup(input.currentLocationId, row.id)
      : null;
    if (travel) {
      const cost = Math.max(0, 12 - travel.travelMinutes * 0.35);
      score += cost;
      breakdown.travel = Math.round(cost * 100) / 100;
    } else if (input.currentLocationId === row.id) {
      score += 20;
      breakdown.travel = 20; // already here: no travel
    }

    // Anti-repeat: a same-kind revisit must lose to the next best candidate.
    const recent = input.recentVisitIds.includes(row.id);
    if (recent) {
      score -= 40;
      breakdown.repeat = -40;
    }

    // Thread relevance: open threads with matching location tags pull SOOYA
    // toward the related spot. 命中越多越相关：首个 +10，每个额外标签 +4，封顶 30。
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags_json) as string[]; } catch { /* ignore */ }
    const threadOverlap = input.threadTags.filter((t) => tags.includes(t) || row.kind === t).length;
    if (threadOverlap > 0) {
      const bonus = Math.min(30, 10 + (threadOverlap - 1) * 4);
      score += bonus;
      breakdown.thread = bonus;
    }

    // Weather modifier.
    const weather = input.weatherCondition ? WEATHER_MODIFIERS[input.weatherCondition] : undefined;
    const weatherBonus = weather?.[row.kind] ?? 0;
    if (weatherBonus !== 0) {
      score += weatherBonus;
      breakdown.weather = weatherBonus;
    }

    // Controlled randomness: only breaks near-ties (deterministic per id).
    let hash = 0;
    for (let i = 0; i < row.id.length; i++) hash = (hash * 31 + row.id.charCodeAt(i)) >>> 0;
    score += (hash % 9) - 4;
    breakdown.tie = (hash % 9) - 4;

    if (!best || score > best.score) {
      best = { row, score, breakdown, travel };
    }
  }

  if (!best || best.score < 0) return null;
  return {
    locationId: best.row.id,
    reason: `location:${best.row.kind}`,
    travelMode: best.travel?.mode ?? 'unknown',
    travelMinutes: best.travel?.travelMinutes ?? 0,
    scoreBreakdown: best.breakdown
  };
}

/** Builds the "known locations" line for the prompt — never invents addresses. */
export function locationContextLine(location: LifeLocation | null, previous: LifeLocation | null): string[] {
  if (!location) return [];
  const label = KIND_LABELS[location.kind] ?? location.kind;
  const lines = [`你现在在${location.name}（${label}）。`];
  if (previous && previous.id !== location.id) {
    lines.push(`你刚从${previous.name}过来。`);
  }
  lines.push('这是你真实的位置，被问起就照实说，不要编造具体地址。');
  return lines;
}

/** Chinese label for a location kind. */
export const KIND_LABELS: Record<LocationKind, string> = {
  home: '家',
  neighborhood: '家附近',
  cafe: '咖啡店',
  restaurant: '餐厅',
  store: '商店',
  park: '公园',
  library: '图书馆',
  mall: '商场',
  transit: '交通枢纽',
  work: '工作地',
  study: '学习场所',
  venue: '场馆',
  outdoor: '户外',
  other: '其他地方'
};
