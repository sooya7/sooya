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

/** 旧库内置地点名称别名 → stable key（仅回填可明确确认的历史地点）。 */
const LEGACY_NAME_KEYS: Array<[string[], string]> = [
  [['家'], 'home'],
  [['家附近'], 'neighborhood'],
  [['街角咖啡店', '咖啡店'], 'cafe'],
  [['社区公园', '公园'], 'park'],
  [['图书馆'], 'library'],
  [['小区超市', '超市'], 'store']
];

function legacySeedForName(name: string): BuiltinSeed | undefined {
  const match = LEGACY_NAME_KEYS.find(([names]) => names.includes(name));
  if (!match) return undefined;
  return BUILTIN_SEEDS.find((s) => s.key === match[1]);
}

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
  /** 城市 repo；缺省由 service 基于地点 repo 的连接自建。 */
  cityRepo?: LifeCityRepo;
}

export class LocationService {
  private enabled = false;
  private readonly defaultTimeZone: string;
  private readonly cityRepo: LifeCityRepo;
  private threadsProvider?: () => Array<{ meta_json: string; title: string }>;

  constructor(
    private readonly repo: LifeLocationRepo,
    private readonly audit: AuditRepo,
    private readonly clock: () => Date = () => new Date(),
    /** Optional weather condition getter keyed on the ACTIVE CITY (cached,
     * never blocks) — the weather identity is the city, not a location id. */
    private readonly weatherConditionFor?: () => string | null,
    opts: LocationServiceOptions = {}
  ) {
    this.defaultTimeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
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

  /**
   * 显式激活某城市（管理端）。城市切换的一致性：
   * - 取消旧城市中未完成的地点移动（clearTravel，禁止跨城残留行程）；
   * - 抽象日常地点（builtin/generated）归属迁移到新城市，保持稳定 key/id；
   * - current location 保持有效（地点本身不删除）；
   * - Weather / WorldContext 自动跟随 active city（weather target 读 activeCity）。
   */
  setActiveCity(id: string): LifeCity | null {
    const target = this.cityRepo.get(id);
    if (!target) return null;
    const previous = this.cityRepo.activeCity();
    if (previous && previous.id !== id) {
      this.repo.clearTravel();
      for (const row of this.repo.list(true)) {
        if (row.city_id === previous.id && (row.source === 'builtin' || row.source === 'generated')) {
          this.repo.updateCityId(row.id, id);
        }
      }
    }
    this.cityRepo.setActiveCity(id);
    return toLifeCity(this.cityRepo.get(id)!);
  }

  /**
   * 运行时统一时区（注入的 env.LIFE_TIME_ZONE）：当前产品范围固定
   * Asia/Shanghai，不保留多城市多时区运行语义。历史 DB 时区字段仅兼容
   * 保留，不参与运行。
   */
  timeZoneFor(_location: LifeLocation | null | undefined): string {
    return this.defaultTimeZone;
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
      // 历史库：绝不重复播种；做幂等 normalization（城市/key/归属/state/travel）。
      this.normalizeLegacyData();
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

  /**
   * 默认城市：只有完全没有城市时才新建宁波（key='default'，浙江/中国）。
   * 已有城市时返回 active 城市；无 active 时恢复已有合法城市——绝不
   * 重复新建宁波、不覆盖用户选择。
   */
  private ensureDefaultCity(): LifeCityRow {
    const all = this.cityRepo.list();
    if (all.length === 0) {
      return this.cityRepo.create({ key: 'default', name: '宁波', region: '浙江', country: '中国', timeZone: this.defaultTimeZone, active: true });
    }
    const active = all.find((c) => c.active === 1);
    if (active) return active;
    return this.restoreActiveCity(all);
  }

  /** 恢复已有合法城市为 active：优先已有宁波，否则最早创建的城市。 */
  private restoreActiveCity(all: LifeCityRow[]): LifeCityRow {
    const ningbo = all.find((c) => c.key === 'default' || c.name === '宁波');
    const target = ningbo ?? all[0]!;
    if (target.active !== 1) this.cityRepo.setActiveCity(target.id);
    return target;
  }

  /**
   * 幂等启动 normalization（旧库兼容，仅历史数据存在时执行）：
   * - 城市：无城市建宁波；有城市无 active 恢复已有（ensureDefaultCity）
   * - 旧 builtin/generated 地点 city_id IS NULL → 绑定 active city
   * - 可明确识别的旧内置地点回填 stable key（绝不覆盖合法 key、不猜自建地点）
   * - current state 指向失效地点 → 优先 home，否则第一个 active 地点
   * - travel_state 引用失效地点 → clear
   * 重复启动不产生重复数据、不改坏已修复状态。
   */
  private normalizeLegacyData(): void {
    const city = this.ensureDefaultCity();
    const activeCityId = city.id;
    const byKey = new Map<string, string>();
    for (const row of this.repo.list(false)) {
      if (!row.key) {
        const seed = BUILTIN_SEEDS.find((s) => s.name === row.name) ?? legacySeedForName(row.name);
        if (seed && (row.source === 'builtin' || row.source === 'generated')) {
          const existing = this.repo.getByKey(seed.key);
          if (!existing || existing.id === row.id) {
            this.repo.setKey(row.id, seed.key);
            byKey.set(seed.key, row.id);
          }
        }
      } else {
        byKey.set(row.key, row.id);
      }
      if (!row.city_id && (row.source === 'builtin' || row.source === 'generated')) {
        this.repo.updateCityId(row.id, activeCityId);
      }
    }
    // current state 修复。
    const state = this.repo.currentState();
    if (state) {
      const current = this.repo.get(state.location_id);
      if (!current || current.active !== 1) {
        const homeId = byKey.get('home');
        const fallbackId = homeId ?? this.repo.list(true)[0]?.id;
        if (fallbackId) {
          this.repo.setState({
            locationId: fallbackId,
            arrivedAt: state.arrived_at,
            confidence: state.confidence
          });
        }
      }
    }
    // travel 失效清理。
    const travel = this.repo.currentTravel();
    if (travel) {
      const from = this.repo.get(travel.from_location_id);
      const to = this.repo.get(travel.to_location_id);
      if (!from || from.active !== 1 || !to || to.active !== 1) {
        this.repo.clearTravel();
      }
    }
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
    const weatherCondition = this.weatherConditionFor?.() ?? null;
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
