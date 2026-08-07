import type { WeatherRepo, WeatherSnapshot, WeatherCondition } from '../../db/repos/weather.repo.js';
import { toWeatherSnapshot } from '../../db/repos/weather.repo.js';
import type { LifeLocationRepo } from '../../db/repos/location.repo.js';
import type { LifeRepo } from '../../db/repos/life.repo.js';

/**
 * Weather snapshot service (next phase). The provider is injected — never
 * hardcoded into the life engine. Caching: <30min fresh, 30-120min usable
 * with a background refresh, >120min stale. Provider failure degrades to the
 * latest snapshot, or 'unknown' when none exists. A failing provider never
 * blocks life or chat.
 */

export interface WeatherLocation {
  key: string;
  city?: string | null;
  region?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface WeatherProvider {
  name: string;
  configured: boolean;
  current(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot>;
}

export interface WeatherEventRecorder {
  record(eventType: string, description: string, meta: Record<string, unknown>): void;
}

const FRESH_MS = 30 * 60 * 1000;
const STALE_MS = 120 * 60 * 1000;

/** Conditions with semantic meaning for life events. */
const SEMANTIC_CONDITIONS: WeatherCondition[] = ['rain', 'snow', 'storm'];

export class WeatherService {
  private provider: WeatherProvider | null = null;
  private enabled = false;

  constructor(
    private readonly repo: WeatherRepo,
    private readonly locations: LifeLocationRepo,
    private readonly events: LifeRepo,
    private readonly clock: () => Date = () => new Date()
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Flag wiring: WEATHER_ENABLED (master WORLD_CONTEXT_ENABLED too). */
  setProvider(provider: WeatherProvider | null): void {
    this.provider = provider?.configured ? provider : null;
  }

  get isEnabled(): boolean {
    return this.enabled && this.provider !== null;
  }

  get providerName(): string | null {
    return this.provider?.name ?? null;
  }

  /** The location key used for caching (city/region or coordinates when present). */
  private locationKeyFor(location: WeatherLocation): string {
    if (location.key) return location.key;
    if (location.lat != null && location.lng != null) return `${Math.round(location.lat * 10)},${Math.round(location.lng * 10)}`;
    return location.city ?? location.region ?? 'unknown';
  }

  /**
   * Latest usable snapshot for a location: fresh cache, or a refresh, or the
   * last known value marked stale, or unknown. Never throws.
   */
  async snapshotFor(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot> {
    const key = this.locationKeyFor(location);
    const cached = this.repo.latest(key);
    const now = this.clock();
    if (cached) {
      const age = now.getTime() - Date.parse(cached.observed_at);
      if (age < FRESH_MS) return toWeatherSnapshot(cached, false);
      if (age < STALE_MS) {
        // Usable now; refresh in the background so the next read is fresh.
        void this.refresh(location, signal);
        return toWeatherSnapshot(cached, false);
      }
    }
    return this.refresh(location, signal);
  }

  /** Synchronous best-known condition (life scoring path); never blocks. */
  cachedCondition(location: WeatherLocation | null): WeatherCondition | null {
    if (!this.enabled || !location) return null;
    const key = this.locationKeyFor(location);
    const cached = this.repo.latest(key);
    return cached?.condition ?? null;
  }

  /** Fetches from the provider, stores it, and records semantic transitions. */
  private async refresh(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot> {
    const key = this.locationKeyFor(location);
    if (!this.isEnabled) return { observedAt: this.clock().toISOString(), condition: 'unknown', provider: 'none', locationKey: key, stale: true };
    try {
      const snapshot = await this.provider!.current(location, signal);
      this.repo.save({
        location_key: key,
        observed_at: snapshot.observedAt,
        condition: snapshot.condition,
        temperature_c: snapshot.temperatureC ?? null,
        feels_like_c: snapshot.feelsLikeC ?? null,
        humidity: snapshot.humidity ?? null,
        precipitation_mm: snapshot.precipitationMm ?? null,
        wind_kph: snapshot.windKph ?? null,
        provider: snapshot.provider
      });
      this.maybeRecordTransition(key, snapshot.condition);
      return { ...snapshot, locationKey: key, stale: false };
    } catch (error) {
      // Provider failure must never block life or chat: fall back to the last
      // snapshot (stale) or unknown.
      const cached = this.repo.latest(key);
      if (cached) return toWeatherSnapshot(cached, true);
      return { observedAt: this.clock().toISOString(), condition: 'unknown', provider: 'none', locationKey: key, stale: true };
    }
  }

  /**
   * Weather events only on semantic change — never on every refresh.
   * rain / snow / storm transitions produce a single life event per episode.
   */
  private maybeRecordTransition(key: string, condition: WeatherCondition): void {
    if (!SEMANTIC_CONDITIONS.includes(condition)) return;
    const previous = this.repo.recent(key, 2)[1];
    if (previous && previous.condition === condition) return; // same episode continues
    const description = condition === 'rain'
      ? '开始下雨了'
      : condition === 'snow'
        ? '下雪了'
        : '外面起风变天了';
    this.events.recordEvent({
      eventType: `weather.${condition === 'rain' ? 'started_raining' : condition === 'snow' ? 'first_snow' : 'weather.storm'}`,
      activity: '天气变化',
      kind: 'rest',
      description,
      happenedAt: this.clock().toISOString(),
      shareable: false,
      meta: { condition, locationKey: key }
    });
  }
}
