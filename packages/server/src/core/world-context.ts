import type { LocationService } from './location/service.js';
import type { WeatherService, WeatherLocation } from './weather/service.js';
import type { WeatherSnapshot, WeatherCondition } from '../db/repos/weather.repo.js';
import type { LifeLocation, LifeLocationRepo } from '../db/repos/location.repo.js';
import { toLifeLocation } from '../db/repos/location.repo.js';
import type { WeatherForecastSummary, DaylightSnapshot } from './weather/forecast.js';
import { localDateOfIso } from '../util/time-zone.js';

/**
 * PLACEHOLDER —— LifeCity / TravelState 类型归 Agent A 定义（contract §1.1，
 * v25 life_cities + travel_state）。本 worktree 尚无 Agent A 的模块，此处按
 * contract 冻结形状占位；Integration 合并时替换为：
 *   import type { LifeCity, TravelState } from '../db/repos/location.repo.js'
 * 并删除下面两个占位接口。
 */
export interface LifeCity {
  id: string;
  name: string;
  region?: string;
  country?: string;
  timeZone: string;   // IANA；唯一 active 城市上下文
  active: boolean;
}

export interface TravelState {
  fromLocationId: string;
  toLocationId: string;
  mode: 'walk' | 'bike' | 'transit' | 'car' | 'unknown';
  startedAt: string;
  expectedArriveAt: string;   // 禁止瞬移；到达后写 state + visit
}

/**
 * WorldContextService (next phase): the unified read surface for location +
 * weather. Everything is derived from persisted state or provider data — a
 * snapshot never invents an address, a forecast or a sunrise. contract §1.3：
 * now / localDate / timeZone / city / location / previousLocation / travel /
 * weather / forecast / daylight / weatherCondition。
 */
export interface WorldSnapshot {
  now: string;
  localDate: string;          // 本地时区日期 YYYY-MM-DD
  timeZone: string;
  city?: LifeCity | null;
  location?: LifeLocation | null;
  previousLocation?: LifeLocation | null;
  travel?: TravelState | null;
  weather?: WeatherSnapshot | null;
  forecast?: WeatherForecastSummary | null;
  daylight?: DaylightSnapshot | null;
  /** Synchronous best-known condition for the life scoring path. */
  weatherCondition?: WeatherCondition | null;
}

export class WorldContextService {
  constructor(
    private readonly location: LocationService,
    private readonly weather: WeatherService,
    private readonly clock: () => Date = () => new Date(),
    private readonly defaultTimeZone = 'Asia/Shanghai',
    /**
     * 可选：location repo（Agent A 模块），仅用于 previousLocation ——
     * 从真实的 visit 记录推导「上一个位置」，绝不编造。Integration 接线时
     * 传入 repos.locations。
     */
    private readonly locationsRepo?: LifeLocationRepo | null
  ) {}

  /**
   * Synchronous snapshot from persisted/cached state only — never blocks,
   * never throws. weather/forecast/daylight 取缓存（或天文估算），未知时为 null。
   */
  snapshot(): WorldSnapshot {
    const now = this.clock();
    const current = this.location.isEnabled ? this.location.current() : null;
    const timeZone = current?.timeZone ?? this.defaultTimeZone;
    const weatherLocation: WeatherLocation | null = current
      ? { key: current.id, city: current.city, region: current.region, lat: current.lat, lng: current.lng }
      : null;
    const condition = weatherLocation ? this.weather.cachedCondition(weatherLocation) : null;

    let weather: WeatherSnapshot | null = null;
    let forecast: WeatherForecastSummary | null = null;
    let daylight: DaylightSnapshot | null = null;
    if (weatherLocation) {
      try { weather = this.weather.cachedSnapshot(weatherLocation); } catch { weather = null; }
      try { forecast = this.weather.cachedForecastSummary(weatherLocation); } catch { forecast = null; }
      try { daylight = this.weather.cachedDaylight(weatherLocation, now, timeZone); } catch { daylight = null; }
    }

    return {
      now: now.toISOString(),
      localDate: localDateOfIso(now.toISOString(), timeZone),
      timeZone,
      city: null,             // Agent A/Integration 的 life_cities（v25）落地后接入
      location: current,
      previousLocation: current ? this.previousLocationFrom(current.id) : null,
      travel: null,           // Agent A/Integration 的 travel_state（v25）落地后接入
      weather,
      forecast,
      daylight,
      weatherCondition: condition
    };
  }

  /**
   * 真实的上一个位置：最近一条 location_id 不同于当前的位置 visit 记录。
   * 依赖持久化的 life_location_visits（LocationService.onActivityResolved /
   * override 每次移动都会写 visit），无需修改 location 模块。
   */
  private previousLocationFrom(currentId: string): LifeLocation | null {
    if (!this.locationsRepo) return null;
    try {
      const visits = this.locationsRepo.recentVisits(50);
      const previous = visits.find((v) => v.location_id !== currentId);
      if (!previous) return null;
      const row = this.locationsRepo.get(previous.location_id);
      return row && row.active === 1 ? toLifeLocation(row) : null;
    } catch { return null; }
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

  /**
   * 全量刷新：current + forecast + daylight（各步失败都被服务层吞掉并降级），
   * 然后返回完整快照。用于管理端刷新/定时任务；不阻塞 Chat/Life。
   */
  async refreshAll(): Promise<WorldSnapshot> {
    const target = this.weatherLocation();
    if (target) {
      const timeZone = this.snapshot().timeZone;
      await this.weather.snapshotFor(target);
      await this.weather.forecastFor(target);
      await this.weather.daylightFor(target, this.clock(), timeZone);
    }
    return this.snapshot();
  }
}
