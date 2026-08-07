import type {
  LifeLocationRepo,
  LifeLocation,
  LifeLocationStateRow,
  LifeLocationRow,
  LifeCity,
  LifeCityRow,
  LocationKind,
  TravelMode
} from '../../db/repos/location.repo.js';
import { toLifeLocation, toLifeCity, LifeCityRepo } from '../../db/repos/location.repo.js';
import type { AuditRepo } from '../../db/repos/feature.repo.js';
import { scoreLocationCandidates, KIND_LABELS, type LocationSelection } from './selector.js';
import type { LifeActivityDefinition } from '../life2/activities.js';
import { DEFAULT_TIME_ZONE, localHourAt } from './tz.js';
import {
  DEFAULT_TRAVEL_MINUTES,
  MODE_LABELS,
  toTravelState,
  travelDueAt,
  travelRemainingMinutes,
  type TravelState
} from './travel.js';
import { NO_GEOCODER, type GeocodingCandidate, type GeocodingProvider } from './geocoding.js';

/**
 * LocationService (next phase): owns SOOYA's own life location — where she
 * is, how she got there, where she is going. Everything is gated behind
 * LOCATION_MODEL_ENABLED; when the flag is off the service is inert and the
 * chat/life behavior is identical to the stable release.
 *
 * 本轮（Agent A 完整收口）：
 * - 内置种子用稳定 key（key 列），禁止显示名称做内部 key；默认出行边真实建库；
 * - 时区统一走 IANA（构造注入 timeZone，默认 Asia/Shanghai），禁止 UTC+8 硬编码；
 * - LifeCity 多城市：location 带 city_id，唯一 active 城市，跨城旅行切换城市与时区；
 * - Geocoding 抽象：无 provider 优雅降级，不读用户 GPS；
 * - TravelState 防瞬移：活动解析触发出发，到达后写 state + visit；
 * - threadLocationTags 接上真实标签，选择器给匹配候选加分。
 */

interface BuiltinSeed {
  key: string;
  name: string;
  kind: LocationKind;
  tags: string[];
  indoor: boolean;
}

const BUILTIN_SEEDS: BuiltinSeed[] = [
  { key: 'home', name: '家', kind: 'home', tags: ['home', 'cozy', 'rest'], indoor: true },
  { key: 'neighborhood', name: '家附近', kind: 'neighborhood', tags: ['home', 'out', 'walk'], indoor: false },
  { key: 'cafe', name: '街角咖啡店', kind: 'cafe', tags: ['cafe', 'drink', 'solo'], indoor: true },
  { key: 'park', name: '社区公园', kind: 'park', tags: ['park', 'out', 'walk'], indoor: false },
  { key: 'library', name: '图书馆', kind: 'library', tags: ['library', 'study', 'quiet'], indoor: true },
  { key: 'store', name: '小区超市', kind: 'store', tags: ['store', 'errand', 'shopping'], indoor: true }
];

/** Default travel edges between the builtin seeds (walking city). */
const BUILTIN_EDGES: Array<[string, string, number, TravelMode]> = [
  ['home', 'neighborhood', 8, 'walk'],
  ['home', 'cafe', 15, 'walk'],
  ['home', 'park', 20, 'walk'],
  ['home', 'library', 25, 'walk'],
  ['home', 'store', 12, 'walk'],
  ['neighborhood', 'cafe', 10, 'walk'],
  ['neighborhood', 'park', 15, 'walk'],
  ['neighborhood', 'store', 8, 'walk'],
  ['cafe', 'library', 12, 'walk'],
  ['park', 'cafe', 15, 'walk']
];

export interface LocationServiceOptions {
  /** IANA 时区；缺省 Asia/Shanghai。禁止从 env 读取。 */
  timeZone?: string;
  /** Geocoding provider；缺省为无操作实现（优雅降级）。 */
  geocoding?: GeocodingProvider;
  /** 城市 repo；缺省由 service 基于地点 repo 的连接自建。 */
  cityRepo?: LifeCityRepo;
}

export class LocationService {
  private enabled = false;
  private readonly defaultTimeZone: string;
  private readonly geocoding: GeocodingProvider;
  private readonly cityRepo: LifeCityRepo;
  private threadsProvider?: () => Array<{ meta_json: string; title: string }>;

  constructor(
    private readonly repo: LifeLocationRepo,
    private readonly audit: AuditRepo,
    private readonly clock: () => Date = () => new Date(),
    /** Optional next-phase weather condition getter (cached, never blocks). */
    private readonly weatherConditionFor?: (location: LifeLocation | null) => string | null,
    /** Next-phase shadow runtime (SHADOW_MODE_ENABLED). */
    private readonly shadow?: import('../shadow.js').ShadowService,
    opts: LocationServiceOptions = {}
  ) {
    this.defaultTimeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
    this.geocoding = opts.geocoding ?? NO_GEOCODER;
    this.cityRepo = opts.cityRepo ?? new LifeCityRepo(repo.dbHandle);
  }

  /** 构造注入的默认时区（用于 Integration 接线说明）。 */
  get timeZoneDefault(): string {
    return this.defaultTimeZone;
  }

  /** Flag wiring: LOCATION_MODEL_ENABLED (master WORLD_CONTEXT_ENABLED too). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.seedBuiltins();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Thread tags 提供方：life2 引擎把 open threads 喂进来（life_threads 行，
   * 含 meta_json + title），选择器据此给匹配候选加分。引擎不传时为空列表。
   */
  setThreadsProvider(provider: () => Array<{ meta_json: string; title: string }>): void {
    this.threadsProvider = provider;
  }

  /** Thread location tags, so the selector can keep threads moving. */
  threadLocationTags(threads: Array<{ meta_json: string; title: string }>): string[] {
    const tags: string[] = [];
    for (const thread of threads) {
      try {
        const meta = JSON.parse(thread.meta_json) as { locationTags?: string[] };
        if (Array.isArray(meta.locationTags)) tags.push(...meta.locationTags);
      } catch { /* ignore */ }
    }
    return tags;
  }

  // ---- cities ----

  listCities(): LifeCity[] {
    return this.cityRepo.list().map(toLifeCity);
  }

  activeCity(): LifeCity | null {
    const city = this.cityRepo.activeCity();
    return city ? toLifeCity(city) : null;
  }

  createCity(input: {
    name: string;
    region?: string | null;
    country?: string | null;
    timeZone?: string;
    active?: boolean;
  }): LifeCity {
    return toLifeCity(this.cityRepo.create(input));
  }

  updateCity(id: string, patch: {
    name?: string;
    region?: string | null;
    country?: string | null;
    timeZone?: string;
    active?: boolean;
  }): LifeCity | undefined {
    const row = this.cityRepo.update(id, patch);
    return row ? toLifeCity(row) : undefined;
  }

  deactivateCity(id: string): boolean {
    return this.cityRepo.deactivate(id);
  }

  /** 显式激活某城市（管理端）。 */
  setActiveCity(id: string): LifeCity | null {
    const row = this.cityRepo.setActiveCity(id);
    return row ? toLifeCity(row) : null;
  }

  /**
   * 解析一个地点应使用的时区：location.timeZone → 所属城市 timeZone →
   * 构造注入的默认时区。
   */
  timeZoneFor(location: LifeLocation | null | undefined): string {
    if (location?.timeZone) return location.timeZone;
    if (location?.cityId) {
      const city = this.cityRepo.get(location.cityId);
      if (city?.time_zone) return city.time_zone;
    }
    return this.defaultTimeZone;
  }

  // ---- geocoding ----

  /** Geocoding 是否已配置（否则 search/reverse 优雅降级）。 */
  get geocodingConfigured(): boolean {
    return this.geocoding.name !== 'none';
  }

  async geocodeSearch(query: string, limit = 5): Promise<GeocodingCandidate[]> {
    if (!this.enabled || !query.trim()) return [];
    const results = await this.geocoding.search(query.trim(), { limit });
    return results.slice(0, Math.max(1, Math.min(20, limit)));
  }

  /** 只接受管理端显式给出的坐标；绝不读取用户 GPS。 */
  async geocodeReverse(lat: number, lng: number): Promise<GeocodingCandidate | null> {
    if (!this.enabled || !this.geocoding.reverse) return null;
    return this.geocoding.reverse(lat, lng);
  }

  // ---- locations ----

  list(): LifeLocation[] {
    return this.repo.list(true).map(toLifeLocation);
  }

  get(id: string): LifeLocation | undefined {
    const row = this.repo.get(id);
    return row ? toLifeLocation(row) : undefined;
  }

  /**
   * 当前所在位置。先结算到期行程（到达 → 写 state + visit），
   * 行程未到期时仍返回出发地（她还在路上）。
   */
  current(): LifeLocation | null {
    if (!this.enabled) return null;
    this.settleTravelIfDue();
    const state = this.repo.currentState();
    if (!state) return null;
    const row = this.repo.get(state.location_id);
    return row && row.active === 1 ? toLifeLocation(row) : null;
  }

  currentState(): LifeLocationStateRow | null {
    if (!this.enabled) return null;
    this.settleTravelIfDue();
    return this.repo.currentState() ?? null;
  }

  /** 进行中的行程（若已到期则先结算）。 */
  currentTravel(): TravelState | null {
    if (!this.enabled) return null;
    return this.settleTravelIfDue();
  }

  /** Home is the implicit baseline before any location state exists. */
  private homeLocation(): LifeLocation | null {
    const row = this.repo.list(true).find((l) => l.kind === 'home');
    return row ? toLifeLocation(row) : null;
  }

  /**
   * One-time builtin seed: stable keys + real edges + baseline home state.
   * 幂等：已播种（有 key）或存在历史数据（v19 升级库/管理端数据）时不重复播种。
   */
  private seedBuiltins(): void {
    const existing = this.repo.list(false);
    if (existing.length > 0) {
      // 历史库：地点由管理端/旧种子维护，绝不重复播种；只补默认城市。
      this.ensureDefaultCity();
      return;
    }
    const city = this.ensureDefaultCity();
    const byKey = new Map<string, string>();
    for (const seed of BUILTIN_SEEDS) {
      const row = this.repo.getByKey(seed.key) ?? this.repo.create({ ...seed, key: seed.key, cityId: city.id, source: 'builtin' });
      byKey.set(seed.key, row.id);
    }
    // 双向建边：步行时间对称，往返都不需要单独配边。
    for (const [from, to, minutes, mode] of BUILTIN_EDGES) {
      const fromId = byKey.get(from);
      const toId = byKey.get(to);
      if (fromId && toId) {
        this.repo.saveEdge(fromId, toId, minutes, mode);
        this.repo.saveEdge(toId, fromId, minutes, mode);
      }
    }
    // 基线：启用即落在家里（后续活动解析从家出发）。
    if (!this.repo.currentState()) {
      const home = this.repo.getByKey('home');
      if (home) {
        const now = this.clock();
        this.repo.setState({ locationId: home.id, arrivedAt: now.toISOString(), confidence: 1 });
        this.repo.recordVisit({ locationId: home.id, enteredAt: now.toISOString() });
      }
    }
  }

  /** 默认城市（key='default'），时区取构造注入的默认值。 */
  private ensureDefaultCity(): LifeCityRow {
    const existing = this.cityRepo.getByKey('default');
    if (existing) return existing;
    return this.cityRepo.create({ key: 'default', name: '默认城市', timeZone: this.defaultTimeZone, active: true });
  }

  // ---- travel ----

  /**
   * 结算到期行程：expectedArriveAt 已过 → 写 state + visit、清空行程、
   * 切换城市（跨城时）；未到期则原样返回，表示仍在路上。
   */
  private settleTravelIfDue(): TravelState | null {
    const row = this.repo.currentTravel();
    if (!row) return null;
    const travel = toTravelState(row);
    if (!travelDueAt(travel, this.clock())) return travel;
    // 到达：以预计到达时刻作为 canonical 的抵达时间，写 state + visit（带行程溯源）。
    this.repo.setState({
      locationId: travel.toLocationId,
      arrivedAt: travel.expectedArriveAt,
      sourcePlanId: travel.sourcePlanId ?? null,
      sourceActivityId: travel.sourceActivityId ?? null,
      confidence: 0.9
    });
    this.repo.recordVisit({
      locationId: travel.toLocationId,
      enteredAt: travel.expectedArriveAt,
      sourcePlanId: travel.sourcePlanId ?? null,
      sourceActivityId: travel.sourceActivityId ?? null
    });
    this.repo.clearTravel();
    this.switchCityIfNeeded(travel.toLocationId);
    return null;
  }

  /** 出发：关闭出发地的开放 visit，写入 travel_state（防瞬移）。 */
  private startTravel(
    fromId: string,
    toId: string,
    travelMinutes: number,
    mode: TravelMode,
    startedAt: Date,
    sourcePlanId?: string | null,
    sourceActivityId?: string | null
  ): TravelState {
    this.repo.closeOpenVisits(fromId, startedAt.toISOString());
    const row = this.repo.setTravel({
      fromLocationId: fromId,
      toLocationId: toId,
      mode,
      startedAt: startedAt.toISOString(),
      expectedArriveAt: new Date(startedAt.getTime() + travelMinutes * 60_000).toISOString(),
      sourcePlanId: sourcePlanId ?? null,
      sourceActivityId: sourceActivityId ?? null
    });
    return toTravelState(row);
  }

  /** 到达后同步 active 城市（跨城旅行 → 城市切换 → 时区切换）。 */
  private switchCityIfNeeded(locationId: string): void {
    const location = this.repo.get(locationId);
    if (!location?.city_id) return;
    const active = this.cityRepo.activeCity();
    if (!active || active.id !== location.city_id) {
      this.cityRepo.setActiveCity(location.city_id);
    }
  }

  /**
   * Called by the life engine after an activity resolves. 触发"出发"：
   * 目标不同于当前所在地时写入 travel_state（禁止瞬移），
   * 到达由 expectedArriveAt 到期后的惰性结算完成。
   */
  onActivityResolved(def: LifeActivityDefinition | null | undefined, kind: string, planId: string | null, activityId: string | null): LocationSelection | null {
    if (!this.enabled) return null;
    const now = this.clock();
    this.settleTravelIfDue();
    const current = this.repo.currentState();
    const currentLocation = current ? this.get(current.location_id) ?? null : null;
    const weatherCondition = this.weatherConditionFor?.(currentLocation ?? this.homeLocation()) ?? null;
    const hour = localHourAt(now, this.timeZoneFor(currentLocation));
    const threadTags = this.threadsProvider ? this.threadLocationTags(this.threadsProvider()) : [];
    const selection = scoreLocationCandidates(
      this.repo.list(true),
      {
        def: def ?? null,
        kind,
        currentLocationId: current?.location_id ?? null,
        recentVisitIds: this.repo.recentlyVisitedLocationIds(24, now.getTime()),
        repeatWindowHours: 24,
        threadTags,
        hour,
        weatherCondition
      },
      (from, to) => {
        const edge = this.repo.edge(from, to);
        return edge ? { travelMinutes: edge.travel_minutes, mode: edge.mode } : undefined;
      },
      now.getTime()
    );
    if (this.shadow?.isEnabled) {
      // Shadow candidate: does dropping the weather modifiers change the pick?
      // Purely computed — the shadow never writes state.
      this.shadow.run({
        subsystem: 'life.location_selector',
        canonicalVersion: 'canonical',
        shadowVersion: 'weather-off',
        input: {
          kind,
          currentLocationId: current?.location_id ?? null,
          recentVisitIds: this.repo.recentlyVisitedLocationIds(24, now.getTime()),
          weatherCondition
        },
        canonicalDecision: selection ? { locationId: selection.locationId, reason: selection.reason } : null,
        runShadow: () => {
          const w = scoreLocationCandidates(
            this.repo.list(true),
            {
              def: def ?? null,
              kind,
              currentLocationId: current?.location_id ?? null,
              recentVisitIds: this.repo.recentlyVisitedLocationIds(24, now.getTime()),
              repeatWindowHours: 24,
              threadTags,
              hour,
              weatherCondition: null
            },
            (from, to) => {
              const edge = this.repo.edge(from, to);
              return edge ? { travelMinutes: edge.travel_minutes, mode: edge.mode } : undefined;
            },
            now.getTime()
          );
          return w ? { locationId: w.locationId, reason: w.reason } : null;
        }
      });
    }
    if (!selection) return null;
    if (current && current.location_id === selection.locationId) return selection;

    // 出发：从当前所在地走向目标（无 state 时以家为基线）。
    const fromId = current?.location_id ?? this.homeLocation()?.id;
    if (!fromId || fromId === selection.locationId) {
      // 极端兜底（种子被删光）：直接落位，不制造无意义的行程。
      this.repo.setState({ locationId: selection.locationId, arrivedAt: now.toISOString(), confidence: 0.9 });
      this.repo.recordVisit({ locationId: selection.locationId, enteredAt: now.toISOString() });
      return selection;
    }
    const edge = this.repo.edge(fromId, selection.locationId);
    const travelMinutes = edge?.travel_minutes ?? DEFAULT_TRAVEL_MINUTES;
    const mode = edge?.mode ?? (selection.travelMode === 'unknown' ? 'walk' : selection.travelMode);
    this.startTravel(fromId, selection.locationId, travelMinutes, mode, now, planId, activityId);
    return selection;
  }

  /** Admin override: moves SOOYA immediately; every override is audited. */
  override(locationId: string, reason: string): LifeLocation | null {
    const location = this.get(locationId);
    if (!location || !location.active) return null;
    const now = this.clock();
    const current = this.repo.currentState();
    if (current) this.repo.closeOpenVisits(current.location_id, now.toISOString());
    this.repo.clearTravel(); // 管理端覆盖视为瞬移，取消进行中的行程
    this.repo.setState({ locationId, arrivedAt: now.toISOString(), confidence: 1 });
    this.repo.recordVisit({ locationId, enteredAt: now.toISOString() });
    this.audit.add('life.location', 'override', locationId, { reason, from: current?.location_id ?? null });
    this.switchCityIfNeeded(locationId);
    return location;
  }

  /** Current location + a label line for the prompt (known facts only). */
  contextLines(): string[] {
    if (!this.enabled) return [];
    const travel = this.settleTravelIfDue(); // 先结算到期行程，再取当前位
    const current = this.current();
    if (!current) return [];
    const label = KIND_LABELS[current.kind] ?? current.kind;
    const lines = [`你现在在${current.name}（${label}）。`];
    if (travel) {
      const target = this.repo.get(travel.toLocationId);
      const minutes = travelRemainingMinutes(travel, this.clock());
      lines.push(`你正在${MODE_LABELS[travel.mode] ?? '出发'}去${target?.name ?? '目的地'}的路上，预计${minutes}分钟后到。`);
    }
    lines.push('这是你真实的位置，被问起就照实说，不要编造具体地址。');
    return lines;
  }
}
