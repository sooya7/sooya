import type { EventBus } from '../events/bus.js';
import type { LifeCity, LifeLocation } from '../db/repos/location.repo.js';
import type { WeatherCondition, WeatherSnapshot } from '../db/repos/weather.repo.js';
import type { LocationService } from './location/service.js';
import type { WorldContextService, WorldSnapshot } from './world-context.js';

export interface WorldPresence {
  city: { id: string; name: string; region?: string | null; country?: string | null } | null;
  location: { id: string; name: string; kind: string } | null;
  travel: {
    fromLocationId: string;
    fromName: string | null;
    toLocationId: string;
    toName: string | null;
    mode: string;
    expectedArriveAt: string;
  } | null;
  weather: {
    condition: WeatherCondition;
    temperatureC: number | null;
    feelsLikeC: number | null;
    observedAt: string;
    stale: boolean;
    provider: string;
  } | null;
  updatedAt: string;
}

function cityDto(city: LifeCity | null | undefined): WorldPresence['city'] {
  return city ? { id: city.id, name: city.name, region: city.region ?? null, country: city.country ?? null } : null;
}

function locationDto(location: LifeLocation | null | undefined): WorldPresence['location'] {
  return location ? { id: location.id, name: location.name, kind: location.kind } : null;
}

function weatherDto(weather: WeatherSnapshot | null | undefined): WorldPresence['weather'] {
  return weather ? {
    condition: weather.condition,
    temperatureC: weather.temperatureC ?? null,
    feelsLikeC: weather.feelsLikeC ?? null,
    observedAt: weather.observedAt,
    stale: weather.stale,
    provider: weather.provider
  } : null;
}

export function toWorldPresence(snapshot: WorldSnapshot, locations: LocationService): WorldPresence {
  const travel = snapshot.travel;
  return {
    city: cityDto(snapshot.city),
    location: locationDto(snapshot.location),
    travel: travel ? {
      fromLocationId: travel.fromLocationId,
      fromName: locations.get(travel.fromLocationId)?.name ?? null,
      toLocationId: travel.toLocationId,
      toName: locations.get(travel.toLocationId)?.name ?? null,
      mode: travel.mode,
      expectedArriveAt: travel.expectedArriveAt
    } : null,
    weather: weatherDto(snapshot.weather),
    updatedAt: snapshot.now
  };
}

/** Semantic fingerprint: timestamps and sub-degree temperature noise are ignored. */
export function presenceFingerprint(presence: WorldPresence): string {
  return JSON.stringify([
    presence.city?.id ?? null,
    presence.city?.name ?? null,
    presence.location?.id ?? null,
    presence.location?.name ?? null,
    presence.travel?.toLocationId ?? null,
    presence.travel?.mode ?? null,
    presence.travel?.expectedArriveAt ?? null,
    presence.weather?.condition ?? null,
    presence.weather?.temperatureC == null ? null : Math.round(presence.weather.temperatureC),
    presence.weather?.stale ?? null
  ]);
}

/** Backwards-compatible descriptive alias for callers that prefer the full name. */
export const worldPresenceFingerprint = presenceFingerprint;

export class WorldPresenceCoordinator {
  private lastFingerprint: string | null = null;

  constructor(
    private readonly world: WorldContextService,
    private readonly locations: LocationService,
    private readonly bus: EventBus
  ) {}

  current(): WorldPresence {
    return toWorldPresence(this.world.snapshot(), this.locations);
  }

  /** Seed the semantic baseline without emitting an initial update. */
  initialize(): WorldPresence {
    const presence = this.current();
    this.lastFingerprint = presenceFingerprint(presence);
    return presence;
  }

  sync(reason = 'sync'): WorldPresence {
    const presence = this.current();
    const fingerprint = presenceFingerprint(presence);
    if (this.lastFingerprint !== null && fingerprint !== this.lastFingerprint) {
      this.bus.publish('world.updated', { presence, reason });
    }
    this.lastFingerprint = fingerprint;
    return presence;
  }

  async refreshWeather(reason = 'weather.refresh'): Promise<WorldPresence> {
    await this.world.refreshAll({ forceCurrent: true });
    return this.sync(reason);
  }
}
