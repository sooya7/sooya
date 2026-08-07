import type { LifeV2Repo, LifeVitalsRow } from '../../db/repos/life-v2.repo.js';
import type { LifeRepo } from '../../db/repos/life.repo.js';

/**
 * Continuous vitals engine (§38). Values drift lazily: nothing is written on
 * a timer; the state is settled from (updated_at → now) whenever it is read,
 * so missed ticks can never freeze her state.
 */

export interface LifeVitals {
  energy: number;
  hunger: number;
  stress: number;
  social_need: number;
  loneliness: number;
  curiosity: number;
  comfort: number;
  focus: number;
  sleep_debt: number;
}

export type VitalEffect = Partial<LifeVitals>;

export const DEFAULT_VITALS: LifeVitals = {
  energy: 72,
  hunger: 40,
  stress: 30,
  social_need: 35,
  loneliness: 30,
  curiosity: 55,
  comfort: 60,
  focus: 55,
  sleep_debt: 1.5
};

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** How a fixed-format activity kind nudges the vitals. */
export const KIND_VITAL_EFFECTS: Record<string, VitalEffect> = {
  sleep: { energy: +34, stress: -8, comfort: +6, sleep_debt: -1.6, hunger: +3, social_need: -2 },
  wake: { energy: +6, focus: +4 },
  meal: { hunger: -42, energy: +9, comfort: +6 },
  rest: { energy: +12, stress: -6, focus: +3 },
  play: { curiosity: +7, stress: -7, energy: -5, comfort: +7, loneliness: -6 },
  out: { social_need: -18, loneliness: -16, curiosity: +9, energy: -8, stress: -4 },
  chore: { comfort: +9, focus: +4, energy: -9, stress: -3 },
  wind_down: { stress: -6, energy: -4, comfort: +4 },
  work: { focus: +6, energy: -9, stress: +4 },
  study: { focus: +9, curiosity: +5, energy: -8, stress: +3 }
};

export class LifeVitalsEngine {
  constructor(
    private readonly repo: LifeV2Repo,
    private readonly clock: () => Date = () => new Date(),
    private readonly lifeRepo?: LifeRepo
  ) {}

  /** Current vitals, lazily settled from the last write. */
  settle(): LifeVitalsRow {
    const row = this.repo.getVitals();
    const now = this.clock();
    if (!row) {
      const fresh: LifeVitalsRow = {
        ...DEFAULT_VITALS,
        updated_at: now.toISOString(),
        meta_json: '{}'
      };
      this.repo.upsertVitals(fresh);
      return fresh;
    }
    const elapsedMs = now.getTime() - Date.parse(row.updated_at);
    if (elapsedMs <= 0) return row;
    const hours = elapsedMs / 3_600_000;
    // E1: the drift depends on what she is actually doing. Sleeping must
    // recover energy and pay down the sleep debt — the old unconditional
    // awake drift made her progressively more tired the longer she slept.
    const asleep = this.lifeRepo?.current()?.kind === 'sleep';
    const v: LifeVitals = asleep
      ? {
          energy: clamp(row.energy + hours * 2.2),
          hunger: clamp(row.hunger + hours * 0.7),
          stress: clamp(row.stress - hours * 1.2),
          social_need: clamp(row.social_need + hours * 0.2),
          loneliness: clamp(row.loneliness + hours * 0.15),
          curiosity: clamp(row.curiosity - hours * 0.4),
          comfort: clamp(row.comfort + hours * 0.5),
          focus: clamp(row.focus + hours * 0.3),
          sleep_debt: Math.max(0, row.sleep_debt - hours * 1.1)
        }
      : {
          energy: clamp(row.energy - hours * 1.6),
          hunger: clamp(row.hunger + hours * 3.2),
          stress: clamp(row.stress - hours * 0.4),
          social_need: clamp(row.social_need + hours * 1.1),
          loneliness: clamp(row.loneliness + hours * 0.9),
          curiosity: clamp(row.curiosity - hours * 0.5),
          comfort: clamp(row.comfort - hours * 0.6),
          focus: clamp(row.focus - hours * 0.8),
          // Sleep debt only decays meaningfully during sleep; awake it keeps a slow edge.
          sleep_debt: Math.max(0, row.sleep_debt - hours * 0.02)
        };
    const settled: LifeVitalsRow = { ...v, updated_at: now.toISOString(), meta_json: row.meta_json };
    this.repo.upsertVitals(settled);
    return settled;
  }

  /** Applies an activity effect; energy/hunger are checked against drift first. */
  applyEffect(effect: VitalEffect): LifeVitalsRow {
    const current = this.settle();
    const next: LifeVitals = { ...current };
    for (const [key, delta] of Object.entries(effect) as Array<[keyof LifeVitals, number]>) {
      if (key === 'sleep_debt') next.sleep_debt = Math.max(0, current.sleep_debt + delta);
      else next[key] = clamp(current[key] + delta);
    }
    const row: LifeVitalsRow = { ...next, updated_at: this.clock().toISOString(), meta_json: current.meta_json };
    this.repo.upsertVitals(row);
    return row;
  }

  /** Conversation effects (applied after a completed reply batch, §49.4). */
  applyConversation(mood: 'warm' | 'neutral' | 'rough'): LifeVitalsRow {
    const effect: VitalEffect =
      mood === 'warm'
        ? { loneliness: -12, social_need: -10, comfort: +5, stress: -4 }
        : mood === 'rough'
          ? { stress: +5, comfort: -4 }
          : { loneliness: -4, social_need: -3 };
    return this.applyEffect(effect);
  }

  summary(v: LifeVitalsRow): string[] {
    const lines: string[] = [];
    if (v.energy < 30) lines.push('精力很低');
    else if (v.energy < 55) lines.push('精力一般');
    if (v.hunger > 75) lines.push('很饿');
    else if (v.hunger > 55) lines.push('有点饿');
    if (v.stress > 65) lines.push('压力偏大');
    if (v.loneliness > 65) lines.push('有点孤单');
    if (v.curiosity > 70) lines.push('好奇心想往外跑');
    if (v.sleep_debt > 4) lines.push(`睡眠债偏高（约${Math.round(v.sleep_debt)}小时）`);
    return lines;
  }
}
