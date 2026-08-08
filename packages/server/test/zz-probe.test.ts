import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
let harness: Harness | null = null;
afterEach(async () => { if (harness) await harness.cleanup(); harness = null; });
function localTime(iso: string): Date { return new Date(`${iso}+08:00`); }
describe('probe', () => {
  it('weather condition via callback', async () => {
    harness = await createHarness({
      skipStickerImport: true, startWorkers: false,
      env: { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true', WEATHER_ENABLED: 'true' },
      clock: () => localTime('2026-08-08T10:00')
    });
    const weather = harness.app.services.weather;
    weather.setProvider({ name: 'fake', configured: true, current: async () => ({ observedAt: localTime('2026-08-08T10:00').toISOString(), condition: 'rain' as const, provider: 'fake', locationKey: 'x', stale: false }) });
    const city = harness.app.services.location.activeCity();
    console.log('CITY:', JSON.stringify(city));
    const target = { key: `${city!.country ?? '中国'}|${city!.region ?? ''}|${city!.name}`, country: city!.country ?? '中国', region: city!.region ?? null, city: city!.name };
    await weather.snapshotFor(target);
    console.log('CACHED:', JSON.stringify(weather.cachedCondition(target)));
    const sel = harness.app.services.location.onActivityResolved({ id: 'walk', kind: 'out', locationAffinity: ['park'] } as never, 'out', null, 'x');
    console.log('SELECTION:', JSON.stringify(sel?.scoreBreakdown));
    expect(true).toBe(true);
  });
});
