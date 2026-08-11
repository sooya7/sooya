import type { DbLike } from '../handle.js';
import { nowIso, sortableId } from '../../util/ids.js';

export type LocationKind =
  | 'home' | 'neighborhood' | 'cafe' | 'restaurant'
  | 'store' | 'park' | 'library' | 'mall'
  | 'transit' | 'work' | 'study' | 'venue'
  | 'outdoor' | 'other';

export type LocationSource = 'builtin' | 'generated' | 'admin' | 'conversation';
export type TravelMode = 'walk' | 'bike' | 'transit' | 'car' | 'unknown';

export interface LifeLocationRow {
  id: string;
  /** 稳定内部 key（如 'home'），种子/去重用；禁止用显示名称做内部 key。 */
  key: string | null;
  name: string;
  kind: LocationKind;
  city_id: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  time_zone: string | null;
  lat: number | null;
  lng: number | null;
  tags_json: string;
  indoor: number;
  visit_weight: number;
  source: LocationSource;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface LifeLocationInput {
  key?: string | null;
  name: string;
  kind: LocationKind;
  cityId?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  timeZone?: string | null;
  lat?: number | null;
  lng?: number | null;
  tags?: string[];
  indoor?: boolean;
  visitWeight?: number;
  source?: LocationSource;
}

export interface LifeLocationStateRow {
  id: number;
  location_id: string;
  arrived_at: string;
  expected_leave_at: string | null;
  source_plan_id: string | null;
  source_activity_id: string | null;
  confidence: number;
  updated_at: string;
}

export interface LifeLocationVisitRow {
  id: string;
  location_id: string;
  entered_at: string;
  left_at: string | null;
  source_plan_id: string | null;
  source_activity_id: string | null;
  created_at: string;
}

export interface LifeLocationEdgeRow {
  from_id: string;
  to_id: string;
  travel_minutes: number;
  mode: TravelMode;
}

/** 进行中的行程（防瞬移）。source_plan/activity 用于到达时写 state 溯源。 */
export interface TravelStateRow {
  id: number;
  from_location_id: string;
  to_location_id: string;
  mode: TravelMode;
  started_at: string;
  expected_arrive_at: string;
  source_plan_id: string | null;
  source_activity_id: string | null;
  created_at: string;
}

/** 冻结契约：LifeCity（docs/NEXT-PHASE-CONTRACTS.md §1.1）。 */
export interface LifeCity {
  id: string;
  name: string;
  region?: string | null;
  country?: string | null;
  timeZone: string; // IANA；唯一 active 城市上下文
  active: boolean;
}

export interface LifeCityRow {
  id: string;
  /** 稳定内部 key（如 'default'），种子幂等用；不出现在公共契约里。 */
  key: string | null;
  name: string;
  region: string | null;
  country: string | null;
  time_zone: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface LifeCityInput {
  key?: string | null;
  name: string;
  region?: string | null;
  country?: string | null;
  timeZone?: string;
  active?: boolean;
}

/** The normalized location shape exposed to services and APIs. */
export interface LifeLocation {
  id: string;
  key?: string | null;
  name: string;
  kind: LocationKind;
  cityId?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  timeZone?: string | null;
  lat?: number | null;
  lng?: number | null;
  tags: string[];
  indoor: boolean;
  visitWeight: number;
  source: LocationSource;
  active: boolean;
}

export function toLifeLocation(row: LifeLocationRow): LifeLocation {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags_json) as string[]; } catch { /* keep empty */ }
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    cityId: row.city_id,
    city: row.city,
    region: row.region,
    country: row.country,
    timeZone: row.time_zone,
    lat: row.lat,
    lng: row.lng,
    tags,
    indoor: row.indoor === 1,
    visitWeight: row.visit_weight,
    source: row.source,
    active: row.active === 1
  };
}

export function toLifeCity(row: LifeCityRow): LifeCity {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    country: row.country,
    timeZone: row.time_zone,
    active: row.active === 1
  };
}

export class LifeLocationRepo {
  constructor(private readonly db: DbLike) {}

  /** 原始句柄：供同一连接上的兄弟 repo（LifeCityRepo 等）复用。 */
  get dbHandle(): DbLike {
    return this.db;
  }

  // ---- locations ----

  list(activeOnly = true): LifeLocationRow[] {
    return this.db.prepare(
      activeOnly
        ? 'SELECT * FROM life_locations WHERE active = 1 ORDER BY visit_weight DESC, name'
        : 'SELECT * FROM life_locations ORDER BY visit_weight DESC, name'
    ).all() as LifeLocationRow[];
  }

  get(id: string): LifeLocationRow | undefined {
    return this.db.prepare('SELECT * FROM life_locations WHERE id = ?').get(id) as LifeLocationRow | undefined;
  }

  /** 按稳定 key 取（种子幂等、内部引用用）。 */
  getByKey(key: string): LifeLocationRow | undefined {
    return this.db.prepare('SELECT * FROM life_locations WHERE key = ? LIMIT 1').get(key) as LifeLocationRow | undefined;
  }

  /** 某城市下的地点。 */
  byCityId(cityId: string): LifeLocationRow[] {
    return this.db.prepare('SELECT * FROM life_locations WHERE city_id = ? ORDER BY visit_weight DESC, name')
      .all(cityId) as LifeLocationRow[];
  }

  create(input: LifeLocationInput): LifeLocationRow {
    const ts = nowIso();
    const row: LifeLocationRow = {
      id: sortableId('loc'),
      key: input.key ?? null,
      name: input.name,
      kind: input.kind,
      city_id: input.cityId ?? null,
      city: input.city ?? null,
      region: input.region ?? null,
      country: input.country ?? null,
      time_zone: input.timeZone ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      tags_json: JSON.stringify(input.tags ?? []),
      indoor: input.indoor ? 1 : 0,
      visit_weight: input.visitWeight ?? 1,
      source: input.source ?? 'admin',
      active: 1,
      created_at: ts,
      updated_at: ts
    };
    this.db.prepare(`
      INSERT INTO life_locations(id, key, name, kind, city_id, city, region, country, time_zone, lat, lng, tags_json, indoor, visit_weight, source, active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
    `).run(row.id, row.key, row.name, row.kind, row.city_id, row.city, row.region, row.country, row.time_zone, row.lat, row.lng, row.tags_json, row.indoor, row.visit_weight, row.source, row.created_at, row.updated_at);
    return row;
  }

  update(id: string, patch: Partial<LifeLocationInput>): LifeLocationRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: LifeLocationRow = {
      ...current,
      key: patch.key !== undefined ? patch.key : current.key,
      name: patch.name ?? current.name,
      kind: patch.kind ?? current.kind,
      city_id: patch.cityId !== undefined ? patch.cityId : current.city_id,
      city: patch.city !== undefined ? patch.city : current.city,
      region: patch.region !== undefined ? patch.region : current.region,
      country: patch.country !== undefined ? patch.country : current.country,
      time_zone: patch.timeZone !== undefined ? patch.timeZone : current.time_zone,
      lat: patch.lat !== undefined ? patch.lat : current.lat,
      lng: patch.lng !== undefined ? patch.lng : current.lng,
      tags_json: patch.tags ? JSON.stringify(patch.tags) : current.tags_json,
      indoor: patch.indoor !== undefined ? (patch.indoor ? 1 : 0) : current.indoor,
      visit_weight: patch.visitWeight ?? current.visit_weight,
      updated_at: nowIso()
    };
    this.db.prepare(`
      UPDATE life_locations SET key=?, name=?, kind=?, city_id=?, city=?, region=?, country=?, time_zone=?, lat=?, lng=?, tags_json=?, indoor=?, visit_weight=?, updated_at=? WHERE id=?
    `).run(next.key, next.name, next.kind, next.city_id, next.city, next.region, next.country, next.time_zone, next.lat, next.lng, next.tags_json, next.indoor, next.visit_weight, next.updated_at, id);
    return next;
  }

  /** Soft delete: keeps visit history and edges consistent. */
  deactivate(id: string): boolean {
    return this.db.prepare('UPDATE life_locations SET active = 0, updated_at = ? WHERE id = ?').run(nowIso(), id).changes === 1;
  }

  // ---- state ----

  currentState(): LifeLocationStateRow | undefined {
    return this.db.prepare('SELECT * FROM life_location_state WHERE id = 1').get() as LifeLocationStateRow | undefined;
  }

  setState(input: {
    locationId: string;
    arrivedAt: string;
    expectedLeaveAt?: string | null;
    sourcePlanId?: string | null;
    sourceActivityId?: string | null;
    confidence?: number;
  }): LifeLocationStateRow {
    const ts = nowIso();
    this.db.prepare(`
      INSERT INTO life_location_state(id, location_id, arrived_at, expected_leave_at, source_plan_id, source_activity_id, confidence, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        location_id=excluded.location_id, arrived_at=excluded.arrived_at,
        expected_leave_at=excluded.expected_leave_at,
        source_plan_id=excluded.source_plan_id,
        source_activity_id=excluded.source_activity_id,
        confidence=excluded.confidence, updated_at=excluded.updated_at
    `).run(input.locationId, input.arrivedAt, input.expectedLeaveAt ?? null, input.sourcePlanId ?? null, input.sourceActivityId ?? null, input.confidence ?? 1, ts);
    return this.currentState()!;
  }

  // ---- visits ----

  recentVisits(limit = 20): LifeLocationVisitRow[] {
    return this.db.prepare('SELECT * FROM life_location_visits ORDER BY entered_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(100, limit))) as LifeLocationVisitRow[];
  }

  /** Finds the most recent persisted visit that overlaps a life event window. */
  visitOverlapping(startedAt: string, endedAt: string): LifeLocationVisitRow | undefined {
    return this.db.prepare(`
      SELECT *
      FROM life_location_visits
      WHERE entered_at <= ?
        AND COALESCE(left_at, ?) >= ?
      ORDER BY entered_at DESC
      LIMIT 1
    `).get(endedAt, endedAt, startedAt) as LifeLocationVisitRow | undefined;
  }

  /** Unique locations visited in the last `hours`, for anti-repeat. */
  recentlyVisitedLocationIds(hours: number, nowMs = Date.now()): string[] {
    const since = new Date(nowMs - hours * 3_600_000).toISOString();
    return (this.db.prepare(
      'SELECT DISTINCT location_id FROM life_location_visits WHERE entered_at > ? ORDER BY entered_at DESC'
    ).all(since) as Array<{ location_id: string }>).map((row) => row.location_id);
  }

  recordVisit(input: {
    locationId: string;
    enteredAt: string;
    leftAt?: string | null;
    sourcePlanId?: string | null;
    sourceActivityId?: string | null;
  }): LifeLocationVisitRow {
    const row: LifeLocationVisitRow = {
      id: sortableId('lvisit'),
      location_id: input.locationId,
      entered_at: input.enteredAt,
      left_at: input.leftAt ?? null,
      source_plan_id: input.sourcePlanId ?? null,
      source_activity_id: input.sourceActivityId ?? null,
      created_at: nowIso()
    };
    this.db.prepare(`
      INSERT INTO life_location_visits(id, location_id, entered_at, left_at, source_plan_id, source_activity_id, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(row.id, row.location_id, row.entered_at, row.left_at, row.source_plan_id, row.source_activity_id, row.created_at);
    return row;
  }

  closeOpenVisits(locationId: string, leftAt: string): number {
    return this.db.prepare(
      'UPDATE life_location_visits SET left_at = ? WHERE location_id = ? AND left_at IS NULL'
    ).run(leftAt, locationId).changes;
  }

  // ---- edges ----

  edge(fromId: string, toId: string): LifeLocationEdgeRow | undefined {
    return this.db.prepare('SELECT * FROM life_location_edges WHERE from_id = ? AND to_id = ?')
      .get(fromId, toId) as LifeLocationEdgeRow | undefined;
  }

  edgesFrom(fromId: string): LifeLocationEdgeRow[] {
    return this.db.prepare('SELECT * FROM life_location_edges WHERE from_id = ?').all(fromId) as LifeLocationEdgeRow[];
  }

  saveEdge(fromId: string, toId: string, travelMinutes: number, mode: TravelMode = 'walk'): void {
    this.db.prepare(`
      INSERT INTO life_location_edges(from_id, to_id, travel_minutes, mode)
      VALUES (?,?,?,?)
      ON CONFLICT(from_id, to_id) DO UPDATE SET travel_minutes=excluded.travel_minutes, mode=excluded.mode
    `).run(fromId, toId, Math.max(1, Math.round(travelMinutes)), mode);
  }

  deleteEdgesTo(locationId: string): number {
    return this.db.prepare('DELETE FROM life_location_edges WHERE from_id = ? OR to_id = ?').run(locationId, locationId).changes;
  }

  // ---- travel (防瞬移) ----

  currentTravel(): TravelStateRow | undefined {
    return this.db.prepare('SELECT * FROM travel_state WHERE id = 1').get() as TravelStateRow | undefined;
  }

  setTravel(input: {
    fromLocationId: string;
    toLocationId: string;
    mode: TravelMode;
    startedAt: string;
    expectedArriveAt: string;
    sourcePlanId?: string | null;
    sourceActivityId?: string | null;
  }): TravelStateRow {
    const ts = nowIso();
    this.db.prepare(`
      INSERT INTO travel_state(id, from_location_id, to_location_id, mode, started_at, expected_arrive_at, source_plan_id, source_activity_id, created_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        from_location_id=excluded.from_location_id, to_location_id=excluded.to_location_id,
        mode=excluded.mode, started_at=excluded.started_at,
        expected_arrive_at=excluded.expected_arrive_at,
        source_plan_id=excluded.source_plan_id, source_activity_id=excluded.source_activity_id,
        created_at=excluded.created_at
    `).run(input.fromLocationId, input.toLocationId, input.mode, input.startedAt, input.expectedArriveAt, input.sourcePlanId ?? null, input.sourceActivityId ?? null, ts);
    return this.currentTravel()!;
  }

  /** 回填稳定 key（仅 normalization 用于可明确识别的旧 builtin/generated 地点）。 */
  setKey(id: string, key: string): void {
    this.db.prepare('UPDATE life_locations SET key = ?, updated_at = ? WHERE id = ?').run(key, nowIso(), id);
  }

  /** 迁移地点的城市归属（保持 key/id 稳定；用于管理端切换城市）。 */
  updateCityId(id: string, cityId: string): void {
    this.db.prepare('UPDATE life_locations SET city_id = ?, updated_at = ? WHERE id = ?').run(cityId, nowIso(), id);
  }

  clearTravel(): void {
    this.db.prepare('DELETE FROM travel_state WHERE id = 1').run();
  }
}

/**
 * LifeCityRepo：城市 CRUD，维护"唯一 active 城市"不变量
 * （任何时候恰好一个城市 active，作为时区/上下文基准）。
 */
export class LifeCityRepo {
  constructor(private readonly db: DbLike) {}

  list(): LifeCityRow[] {
    return this.db.prepare('SELECT * FROM life_cities ORDER BY active DESC, created_at ASC, name').all() as LifeCityRow[];
  }

  get(id: string): LifeCityRow | undefined {
    return this.db.prepare('SELECT * FROM life_cities WHERE id = ?').get(id) as LifeCityRow | undefined;
  }

  getByKey(key: string): LifeCityRow | undefined {
    return this.db.prepare('SELECT * FROM life_cities WHERE key = ? LIMIT 1').get(key) as LifeCityRow | undefined;
  }

  activeCity(): LifeCityRow | undefined {
    return this.db.prepare('SELECT * FROM life_cities WHERE active = 1 LIMIT 1').get() as LifeCityRow | undefined;
  }

  /** 新建城市；未显式指定时，第一个城市自动成为 active。 */
  create(input: LifeCityInput): LifeCityRow {
    const ts = nowIso();
    const wantActive = input.active ?? !this.activeCity();
    const row: LifeCityRow = {
      id: sortableId('city'),
      key: input.key ?? null,
      name: input.name,
      region: input.region ?? null,
      country: input.country ?? null,
      time_zone: input.timeZone ?? 'Asia/Shanghai',
      active: wantActive ? 1 : 0,
      created_at: ts,
      updated_at: ts
    };
    const insert = () => {
      if (wantActive) this.db.prepare('UPDATE life_cities SET active = 0, updated_at = ? WHERE active = 1').run(ts);
      this.db.prepare(`
        INSERT INTO life_cities(id, key, name, region, country, time_zone, active, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(row.id, row.key, row.name, row.region, row.country, row.time_zone, row.active, row.created_at, row.updated_at);
    };
    this.db.transaction(insert)();
    return row;
  }

  update(id: string, patch: Partial<LifeCityInput>): LifeCityRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: LifeCityRow = {
      ...current,
      key: patch.key !== undefined ? patch.key : current.key,
      name: patch.name ?? current.name,
      region: patch.region !== undefined ? patch.region : current.region,
      country: patch.country !== undefined ? patch.country : current.country,
      time_zone: patch.timeZone ?? current.time_zone,
      active: patch.active !== undefined ? (patch.active ? 1 : 0) : current.active,
      updated_at: nowIso()
    };
    const run = () => {
      if (next.active) this.db.prepare('UPDATE life_cities SET active = 0, updated_at = ? WHERE active = 1 AND id <> ?').run(next.updated_at, id);
      this.db.prepare('UPDATE life_cities SET key=?, name=?, region=?, country=?, time_zone=?, active=?, updated_at=? WHERE id=?')
        .run(next.key, next.name, next.region, next.country, next.time_zone, next.active, next.updated_at, id);
      // 不变量兜底：若把唯一 active 城市改成了 inactive，自动补位一个。
      if (!this.activeCity()) {
        const fallback = this.db.prepare('SELECT id FROM life_cities WHERE id <> ? ORDER BY created_at ASC LIMIT 1').get(id) as { id: string } | undefined;
        if (fallback) {
          this.db.prepare('UPDATE life_cities SET active = 1, updated_at = ? WHERE id = ?').run(next.updated_at, fallback.id);
        }
      }
    };
    this.db.transaction(run)();
    return this.get(id);
  }

  /**
   * 停用城市。被停用的是当前 active 城市时，自动补位另一个（按创建时间）；
   * 若这是唯一城市，拒绝停用（返回 false），保证"至少一个 active 城市"。
   */
  deactivate(id: string): boolean {
    const current = this.get(id);
    if (!current) return false;
    const run = () => {
      const ts = nowIso();
      if (current.active === 1) {
        const fallback = this.db.prepare('SELECT id FROM life_cities WHERE id <> ? ORDER BY created_at ASC LIMIT 1').get(id) as { id: string } | undefined;
        if (!fallback) return false; // 唯一城市不可停用
        this.db.prepare('UPDATE life_cities SET active = 0, updated_at = ? WHERE id = ?').run(ts, id);
        this.db.prepare('UPDATE life_cities SET active = 1, updated_at = ? WHERE id = ?').run(ts, fallback.id);
      } else {
        this.db.prepare('UPDATE life_cities SET active = 0, updated_at = ? WHERE id = ?').run(ts, id);
      }
      return true;
    };
    return this.db.transaction(run)() as boolean;
  }

  /** 显式切换 active 城市（跨城旅行到达时调用）。 */
  setActiveCity(id: string): LifeCityRow | undefined {
    const target = this.get(id);
    if (!target) return undefined;
    const run = () => {
      const ts = nowIso();
      this.db.prepare('UPDATE life_cities SET active = 0, updated_at = ? WHERE active = 1').run(ts);
      this.db.prepare('UPDATE life_cities SET active = 1, updated_at = ? WHERE id = ?').run(ts, id);
    };
    this.db.transaction(run)();
    return this.get(id);
  }
}
