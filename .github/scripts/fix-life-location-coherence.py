from pathlib import Path
import re

ROOT = Path('.')

# ---------------------------------------------------------------------------
# 1) Give every autonomous activity an explicit set of places where it makes
# sense. The selector already supported this field, but the production library
# never populated it, so current-place inertia could win over semantics.
# ---------------------------------------------------------------------------
activities_path = ROOT / 'packages/server/src/core/life2/activities.ts'
activities = activities_path.read_text(encoding='utf-8')
affinities = {
    'cook': ['home'],
    'eat': ['home', 'cafe', 'restaurant'],
    'nap': ['home'],
    'rest': ['home'],
    'reading': ['home', 'library', 'cafe'],
    'gaming': ['home'],
    'music': ['home'],
    'craft': ['home'],
    'walk': ['park', 'neighborhood', 'outdoor'],
    'cafe': ['cafe'],
    'shopping': ['store', 'mall'],
    'organize': ['home'],
    'laundry': ['home'],
    'cleaning': ['home'],
    'shower': ['home'],
    'garden': ['home'],
    'study': ['home', 'library', 'study', 'cafe'],
    'work': ['home', 'work'],
}
for activity_id, kinds in affinities.items():
    pattern = re.compile(rf"(\{{ id: '{re.escape(activity_id)}'.*?tags: \[[^\]]*\],)(\s+minDurationMinutes:)")
    replacement = r"\1 locationAffinity: [" + ', '.join(repr(k) for k in kinds) + r"],\2"
    activities, count = pattern.subn(replacement, activities, count=1)
    if count != 1:
        raise RuntimeError(f'could not add locationAffinity for {activity_id}')
activities_path.write_text(activities, encoding='utf-8')

# ---------------------------------------------------------------------------
# 2) When compatible places actually exist, incompatible places are fallback
# only. This prevents "already at the park" (+20) from defeating a reading
# activity whose valid places are home/library/cafe.
# ---------------------------------------------------------------------------
selector_path = ROOT / 'packages/server/src/core/location/selector.ts'
selector = selector_path.read_text(encoding='utf-8')
old_selector = """  const affinityKinds = input.def?.locationAffinity ?? [];
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
"""
new_selector = """  const affinityKinds = input.def?.locationAffinity ?? [];
  const hasCompatibleCandidate = affinityKinds.length > 0 && candidates.some((row) => affinityKinds.includes(row.kind));
  const repeatCutoff = clockMs - input.repeatWindowHours * 3_600_000;
  let best: { row: LifeLocationRow; score: number; breakdown: Record<string, number>; travel: { travelMinutes: number; mode: TravelMode } | null | undefined } | null = null;

  for (const row of candidates) {
    const breakdown: Record<string, number> = {};
    let score = 0;

    // Compatibility is a semantic constraint when at least one valid place is
    // available. Anti-repeat/weather/current-place bonuses may choose between
    // compatible places, but must not turn a park into the default reading or
    // shower location merely because she already happens to be there.
    if (affinityKinds.length > 0) {
      if (affinityKinds.includes(row.kind)) {
        score += 50;
        breakdown.affinity = 50;
      } else if (hasCompatibleCandidate) {
        score -= 60;
        breakdown.affinity = -60;
      } else if (row.kind === 'home' || row.kind === 'neighborhood') {
        // Custom/legacy installations can delete all matching kinds. Keep a
        // graceful living-area fallback instead of returning no location.
        score += 10;
        breakdown.affinity = 10;
      }
    } else if (row.kind === 'home' || row.kind === 'neighborhood') {
      // No affinity (routine/undefined): stay in the living area.
      score += 30;
      breakdown.affinity = 30;
    }
"""
if old_selector not in selector:
    raise RuntimeError('selector compatibility block changed')
selector = selector.replace(old_selector, new_selector, 1)
selector_path.write_text(selector, encoding='utf-8')

# ---------------------------------------------------------------------------
# 3) Make travel a first-class Life state. Before this fix the engine wrote
# "看小说" first and only afterwards started a trip to a matching place. That
# made the Header and prompt say she was already doing the destination activity
# while Location correctly still had her at the departure place.
# ---------------------------------------------------------------------------
engine_path = ROOT / 'packages/server/src/core/life2/engine.ts'
engine = engine_path.read_text(encoding='utf-8')
marker = """export interface LifeSimResult {
  changed: boolean;
  activity: string;
  kind: string;
  mood: string;
  endedPrevious: LifeLogRow | null;
}
"""
insert = marker + """
type ResolvedLifeActivity = ResolvedActivity & {
  source: string;
  activityId?: string | null;
  planId?: string | null;
};

interface PendingTravelActivity {
  activity: string;
  kind: string;
  mood: string;
  source: string;
  activityId: string | null;
  planId: string | null;
  endsAt: string;
}
"""
if marker not in engine:
    raise RuntimeError('LifeSimResult marker not found')
engine = engine.replace(marker, insert, 1)

new_tick = r'''  tick(): LifeSimResult {
    const at = this.clock();
    const parts = localParts(at, this.tzOffset, this.settings.timeZone);
    const v = this.vitals.settle();
    const theme = this.dayTheme();
    const current = this.repo.current();
    const endedPrevious: LifeLogRow | null = null;

    // Travel is a real current activity. LocationService deliberately keeps
    // the departure place until arrival; Life must therefore say "在路上"
    // instead of claiming the destination activity has already begun.
    const activeTravel = this.location?.currentTravel() ?? null;
    if (activeTravel) {
      const currentMeta = current ? safeMeta(current.meta_json) : {};
      if (current && currentMeta.source === 'travel' && currentMeta.toLocationId === activeTravel.toLocationId) {
        return { changed: false, activity: current.activity, kind: current.kind, mood: current.mood, endedPrevious };
      }
      const pending = current
        ? this.pendingFromCurrent(current)
        : this.pendingFromResolved(
            activeTravel.sourceActivityId && defById(activeTravel.sourceActivityId)
              ? this.scored(parts, at, activeTravel.sourceActivityId, 'travel:recovered', activeTravel.sourcePlanId ?? undefined)
              : this.routineActivity(parts, at)
          );
      return this.enterTravel(activeTravel, pending).result;
    }

    // currentTravel() above also performs lazy arrival settlement. If the Life
    // row is our synthetic travel state and the destination was reached, begin
    // the exact pending activity now. Do not run location selection again: we
    // have literally just arrived at the selected compatible place.
    if (current && safeMeta(current.meta_json).source === 'travel') {
      const resumed = this.resumeAfterTravel(current, parts, theme);
      if (resumed) return resumed;
      // A missing trip with a different current location means an admin
      // override cancelled travel. Fall through and choose a fresh activity
      // for that place instead of remaining "在路上" forever.
    }

    // Ongoing activity: keep until its ends_at. Also repair states created by
    // older builds: if e.g. "看小说" is currently stored at a park, immediately
    // start a real trip to a compatible place on the next tick.
    if (current && Date.parse(current.ends_at) > at.getTime() && current.kind !== 'sleep') {
      const repaired = this.repairOngoingLocation(current);
      if (repaired) return repaired;
      if (safeMeta(current.meta_json).source !== 'travel') {
        return { changed: false, activity: current.activity, kind: current.kind, mood: current.mood, endedPrevious };
      }
    }

    const resolved = this.resolveNext(parts, v, theme);
    if (current && current.activity === resolved.activity && current.started_at === resolved.startedAt.toISOString()) {
      return { changed: false, activity: current.activity, kind: current.kind, mood: current.mood, endedPrevious };
    }

    const activityId = resolved.activityId ?? null;
    const planId = resolved.planId ?? null;

    // Pick/enter the place before beginning the activity. If that requires a
    // trip, write a travel Life row first and defer the activity until arrival.
    if (activityId || resolved.source === 'routine') {
      this.location?.onActivityResolved(activityId ? defById(activityId) : null, resolved.kind, planId, activityId);
      const startedTravel = this.location?.currentTravel() ?? null;
      if (startedTravel) {
        const entered = this.enterTravel(startedTravel, this.pendingFromResolved(resolved));
        if (current && safeMeta(current.meta_json).source !== 'travel' && current.kind !== 'sleep' && current.kind !== 'wake') {
          this.finishActivity(current, parts, entered.previous?.id ?? null);
        }
        this.v2.expireShareCandidates();
        this.decayThreads();
        this.settlePlanWindows(parts);
        this.ensureSeedThreads();
        return entered.result;
      }
    }

    // No movement required: the activity and current place are already
    // compatible, so begin it normally.
    const advanced = this.repo.advance({
      activity: resolved.activity,
      kind: resolved.kind,
      mood: resolved.mood,
      startedAt: resolved.startedAt.toISOString(),
      endsAt: resolved.endsAt.toISOString(),
      meta: { source: resolved.source, activityId, planId }
    }, { recordCompletionEvent: false });
    if (current && safeMeta(current.meta_json).source !== 'travel' && current.kind !== 'sleep' && current.kind !== 'wake') {
      this.finishActivity(current, parts, advanced.previous?.id ?? null);
    }
    this.rollIncident(resolved, parts, theme);
    this.v2.expireShareCandidates();
    this.decayThreads();
    this.settlePlanWindows(parts);
    this.ensureSeedThreads();
    return { changed: true, activity: resolved.activity, kind: resolved.kind, mood: resolved.mood, endedPrevious: advanced.previous };
  }

  private pendingFromResolved(resolved: ResolvedLifeActivity): PendingTravelActivity {
    return {
      activity: resolved.activity,
      kind: resolved.kind,
      mood: resolved.mood,
      source: resolved.source,
      activityId: resolved.activityId ?? null,
      planId: resolved.planId ?? null,
      endsAt: resolved.endsAt.toISOString()
    };
  }

  private pendingFromCurrent(current: LifeRepoCurrent): PendingTravelActivity {
    const meta = safeMeta(current.meta_json);
    return {
      activity: current.activity,
      kind: current.kind,
      mood: current.mood,
      source: typeof meta.source === 'string' ? meta.source : 'recovered',
      activityId: typeof meta.activityId === 'string' ? meta.activityId : null,
      planId: typeof meta.planId === 'string' ? meta.planId : null,
      endsAt: current.ends_at
    };
  }

  private enterTravel(
    travel: {
      toLocationId: string;
      startedAt: string;
      expectedArriveAt: string;
      sourcePlanId?: string | null;
      sourceActivityId?: string | null;
    },
    pending: PendingTravelActivity
  ): { result: LifeSimResult; previous: LifeLogRow | null } {
    const destination = this.location?.get(travel.toLocationId) ?? null;
    const activity = destination?.kind === 'home'
      ? '回家路上'
      : destination?.name
        ? `去${destination.name}路上`
        : '在路上';
    const advanced = this.repo.advance({
      activity,
      kind: 'out',
      mood: '在路上',
      startedAt: travel.startedAt,
      endsAt: travel.expectedArriveAt,
      meta: {
        source: 'travel',
        toLocationId: travel.toLocationId,
        pendingActivity: pending
      }
    }, { recordCompletionEvent: false });
    return {
      previous: advanced.previous,
      result: { changed: true, activity, kind: 'out', mood: '在路上', endedPrevious: advanced.previous }
    };
  }

  private resumeAfterTravel(
    current: LifeRepoCurrent,
    parts: { dayIndex: number; hour: number; minute: number; dayStartMs: number; localDate: string },
    theme: LifeDayThemeRow
  ): LifeSimResult | null {
    const meta = safeMeta(current.meta_json);
    const toLocationId = typeof meta.toLocationId === 'string' ? meta.toLocationId : null;
    const here = this.location?.current() ?? null;
    if (!toLocationId || !here || here.id !== toLocationId) return null;
    const raw = meta.pendingActivity;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const pending = raw as Record<string, unknown>;
    const activityId = typeof pending.activityId === 'string' ? pending.activityId : null;
    const planId = typeof pending.planId === 'string' ? pending.planId : null;
    const now = this.clock();
    let resolved: ResolvedLifeActivity;
    if (activityId && defById(activityId)) {
      resolved = this.scored(parts, now, activityId, 'travel:arrived', planId ?? undefined);
    } else {
      const storedEnd = typeof pending.endsAt === 'string' ? Date.parse(pending.endsAt) : Number.NaN;
      const minEnd = now.getTime() + 15 * 60_000;
      resolved = {
        activity: typeof pending.activity === 'string' ? pending.activity : '休息一下',
        kind: (typeof pending.kind === 'string' ? pending.kind : 'rest') as ResolvedActivity['kind'],
        mood: typeof pending.mood === 'string' ? pending.mood : '还行',
        startedAt: now,
        endsAt: new Date(Number.isFinite(storedEnd) ? Math.max(storedEnd, minEnd) : minEnd),
        source: 'travel:arrived',
        activityId: null,
        planId
      };
    }
    const advanced = this.repo.advance({
      activity: resolved.activity,
      kind: resolved.kind,
      mood: resolved.mood,
      startedAt: resolved.startedAt.toISOString(),
      endsAt: resolved.endsAt.toISOString(),
      meta: { source: resolved.source, activityId: resolved.activityId ?? null, planId: resolved.planId ?? null }
    }, { recordCompletionEvent: false });
    this.rollIncident(resolved, parts, theme);
    this.v2.expireShareCandidates();
    this.decayThreads();
    this.settlePlanWindows(parts);
    this.ensureSeedThreads();
    return { changed: true, activity: resolved.activity, kind: resolved.kind, mood: resolved.mood, endedPrevious: advanced.previous };
  }

  private repairOngoingLocation(current: LifeRepoCurrent): LifeSimResult | null {
    if (!this.location?.isEnabled) return null;
    const meta = safeMeta(current.meta_json);
    const activityId = typeof meta.activityId === 'string' ? meta.activityId : null;
    const def = activityId ? defById(activityId) : undefined;
    if (!def?.locationAffinity?.length) return null;
    const here = this.location.current();
    if (!here || def.locationAffinity.includes(here.kind)) return null;
    const planId = typeof meta.planId === 'string' ? meta.planId : null;
    this.location.onActivityResolved(def, current.kind, planId, activityId);
    const travel = this.location.currentTravel();
    if (!travel) return null;
    // This is a repair of an impossible pre-existing state, not completion of
    // that activity. File the old row for audit/history but do not generate an
    // outcome/share candidate for something she did not actually finish.
    return this.enterTravel(travel, this.pendingFromCurrent(current)).result;
  }

  private resolveNext('''

pattern = re.compile(r"  tick\(\): LifeSimResult \{.*?\n  private resolveNext\(", re.S)
engine, count = pattern.subn(new_tick, engine, count=1)
if count != 1:
    raise RuntimeError('could not replace LifeSimEngine.tick')
engine_path.write_text(engine, encoding='utf-8')

# ---------------------------------------------------------------------------
# 4) Update the old anti-repeat selector test to use the real walk semantics.
# Strict compatibility should still allow anti-repeat to choose neighborhood
# over a recently used park, but not an unrelated store/home activity place.
# ---------------------------------------------------------------------------
loc_test_path = ROOT / 'packages/server/test/location.test.ts'
loc_test = loc_test_path.read_text(encoding='utf-8')
loc_test = loc_test.replace(
    "{ id: 'walk', kind: 'out', locationAffinity: ['park'] } as never,",
    "{ id: 'walk', kind: 'out', locationAffinity: ['park', 'neighborhood', 'outdoor'] } as never,",
    1
)
loc_test = loc_test.replace(
    "// 公园刚访问过（-40）被 anti-repeat 压制：无论 tie 如何，park 都不可能\n    // 胜出（park≈13 远低于 store≈26 / 家附近≈27；家附近的亲缘+近距与\n    // store 的 thread 加成在同一量级，由确定性 hash 破平，两者胜出都合理）。\n    expect(result?.locationId).not.toBe(park.id);\n    // thread 加成真实参与决策：当 store 胜出时其 breakdown 必须含 thread。\n    if (result?.locationId === store.id) {\n      expect(result?.scoreBreakdown.thread).toBe(10);\n    }",
    "// 公园刚访问过（-40）后仍只能在 walk 的兼容地点里换一个，不能\n    // 因为 thread/当前地点加分跑去与散步语义无关的室内地点。\n    expect(result?.locationId).not.toBe(park.id);\n    expect(result?.locationId).not.toBe(store.id);"
)
loc_test_path.write_text(loc_test, encoding='utf-8')

# ---------------------------------------------------------------------------
# 5) Focused regression tests for the exact bug shown in the Header.
# ---------------------------------------------------------------------------
coherence_test = r'''import { afterEach, describe, expect, it } from 'vitest';
import { ACTIVITY_LIBRARY, defById } from '../src/core/life2/activities.js';
import { scoreLocationCandidates } from '../src/core/location/selector.js';
import type { LifeLocationRow } from '../src/db/repos/location.repo.js';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

describe('Life activity/location coherence', () => {
  it('gives autonomous activities explicit location semantics', () => {
    for (const def of ACTIVITY_LIBRARY) expect(def.locationAffinity?.length, def.id).toBeGreaterThan(0);
    expect(defById('reading')?.locationAffinity).toEqual(['home', 'library', 'cafe']);
    expect(defById('reading')?.locationAffinity).not.toContain('park');
    expect(defById('walk')?.locationAffinity).toEqual(expect.arrayContaining(['park', 'neighborhood']));
  });

  it('does not let current-place inertia keep reading in a park when compatible places exist', () => {
    const make = (id: string, kind: string): LifeLocationRow => ({
      id,
      key: id,
      name: id,
      kind,
      city_id: 'city',
      region: null,
      country: null,
      time_zone: null,
      lat: null,
      lng: null,
      tags_json: '[]',
      indoor: kind === 'park' ? 0 : 1,
      visit_weight: 1,
      source: 'builtin',
      active: 1,
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z'
    } as LifeLocationRow);
    const park = make('park', 'park');
    const home = make('home', 'home');
    const library = make('library', 'library');
    const result = scoreLocationCandidates(
      [park, home, library],
      {
        def: defById('reading'),
        kind: 'play',
        currentLocationId: park.id,
        recentVisitIds: [home.id],
        repeatWindowHours: 24,
        threadTags: [],
        hour: 8,
        weatherCondition: 'cloudy'
      },
      () => ({ travelMinutes: 20, mode: 'walk' }),
      Date.parse('2026-08-12T00:00:00.000Z')
    );
    expect(result).not.toBeNull();
    expect(['home', 'library', 'cafe']).toContain(result!.reason.replace('location:', ''));
    expect(result!.locationId).not.toBe(park.id);
  });

  it('repairs an existing park + reading state into travel, then starts reading only after arrival', async () => {
    let at = localTime('2026-08-12T08:00');
    harness = await createHarness({
      skipStickerImport: true,
      startWorkers: false,
      env: {
        ENABLE_LIFE_V2: 'true',
        WORLD_CONTEXT_ENABLED: 'true',
        LOCATION_MODEL_ENABLED: 'true',
        WEATHER_ENABLED: 'false',
        ENABLE_BACKGROUND_JOBS: 'false'
      },
      clock: () => at
    });

    const location = harness.app.services.location;
    const park = location.list().find((item) => item.kind === 'park')!;
    location.override(park.id, 'regression setup');
    harness.app.repos.life.advance({
      activity: '看小说',
      kind: 'play',
      mood: '专注',
      startedAt: localTime('2026-08-12T07:50').toISOString(),
      endsAt: localTime('2026-08-12T09:30').toISOString(),
      meta: { source: 'scored', activityId: 'reading', planId: null }
    }, { recordCompletionEvent: false });

    const repaired = harness.app.services.life.tick();
    const travel = location.currentTravel();
    expect(repaired.changed).toBe(true);
    expect(travel).not.toBeNull();
    expect(harness.app.repos.life.current()?.activity).toContain('路上');
    expect(harness.app.repos.life.current()?.mood).toBe('在路上');
    expect(location.current()?.kind).toBe('park');

    const target = location.get(travel!.toLocationId)!;
    expect(defById('reading')!.locationAffinity).toContain(target.kind);

    at = new Date(Date.parse(travel!.expectedArriveAt) + 60_000);
    const arrived = harness.app.services.life.tick();
    const current = harness.app.repos.life.current()!;
    expect(arrived.changed).toBe(true);
    expect(location.current()?.id).toBe(target.id);
    expect(location.currentTravel()).toBeNull();
    expect(current.activity).not.toContain('路上');
    expect(JSON.parse(current.meta_json).activityId).toBe('reading');
    expect(defById('reading')!.locationAffinity).toContain(location.current()?.kind);
  });
});
'''
(ROOT / 'packages/server/test/life-location-coherence.test.ts').write_text(coherence_test, encoding='utf-8')
