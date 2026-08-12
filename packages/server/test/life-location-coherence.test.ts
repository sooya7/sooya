import { afterEach, describe, expect, it } from 'vitest';
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
