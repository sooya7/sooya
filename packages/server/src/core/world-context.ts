import type { LocationService } from './location/service.js';
import type { WeatherService, WeatherLocation } from './weather/service.js';
import type { WeatherSnapshot, WeatherCondition } from '../db/repos/weather.repo.js';
import type { LifeLocation } from '../db/repos/location.repo.js';

/**
 * WorldContextService (next phase): the unified read surface for location +
 * weather. Everything is derived from persisted state; a snapshot never
 * invents an address or a forecast.
 */
export interface WorldSnapshot {
  now: string;
  timeZone: string;
  location?: LifeLocation | null;
  previousLocation?: LifeLocation | null;
  weather?: WeatherSnapshot | null;
  /** Synchronous best-known condition for the life scoring path. */
  weatherCondition?: WeatherCondition | null;
}

export class WorldContextService {
  constructor(
    private readonly location: LocationService,
    private readonly weather: WeatherService,
    private readonly clock: () => Date = () => new Date(),
    private readonly defaultTimeZone = 'Asia/Shanghai'
  ) {}

  /** Synchronous snapshot from persisted state (weather cached or unknown). */
  snapshot(): WorldSnapshot {
    const now = this.clock();
    const current = this.location.isEnabled ? this.location.current() : null;
    const state = this.location.isEnabled ? this.location.currentState() : null;
    const weatherLocation: WeatherLocation | null = current
      ? { key: current.id, city: current.city, region: current.region, lat: current.lat, lng: current.lng }
      : null;
    const condition = weatherLocation ? this.weather.cachedCondition(weatherLocation) : null;
    return {
      now: now.toISOString(),
      timeZone: current?.timeZone ?? this.defaultTimeZone,
      location: current,
      previousLocation: null,
      weather: null,
      weatherCondition: condition
    };
  }

  /** The current location as a weather query target, when known. */
  weatherLocation(): WeatherLocation | null {
    const current = this.location.isEnabled ? this.location.current() : null;
    return current
      ? { key: current.id, city: current.city, region: current.region, lat: current.lat, lng: current.lng }
      : null;
  }

  /** Refreshes the weather for the current location (never blocks callers). */
  async refreshWeather(): Promise<WeatherSnapshot | null> {
    const target = this.weatherLocation();
    if (!target) return null;
    return this.weather.snapshotFor(target);
  }
}
