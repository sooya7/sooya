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
  name: string;
  kind: LocationKind;
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
  name: string;
  kind: LocationKind;
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

/** The normalized location shape exposed to services and APIs. */
export interface LifeLocation {
  id: string;
  name: string;
  kind: LocationKind;
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
    name: row.name,
    kind: row.kind,
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

export class LifeLocationRepo {
  constructor(private readonly db: DbLike) {}

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

  create(input: LifeLocationInput): LifeLocationRow {
    const ts = nowIso();
    const row: LifeLocationRow = {
      id: sortableId('loc'),
      name: input.name,
      kind: input.kind,
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
      INSERT INTO life_locations(id, name, kind, city, region, country, time_zone, lat, lng, tags_json, indoor, visit_weight, source, active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
    `).run(row.id, row.name, row.kind, row.city, row.region, row.country, row.time_zone, row.lat, row.lng, row.tags_json, row.indoor, row.visit_weight, row.source, row.created_at, row.updated_at);
    return row;
  }

  update(id: string, patch: Partial<LifeLocationInput>): LifeLocationRow | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: LifeLocationRow = {
      ...current,
      name: patch.name ?? current.name,
      kind: patch.kind ?? current.kind,
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
      UPDATE life_locations SET name=?, kind=?, city=?, region=?, country=?, time_zone=?, lat=?, lng=?, tags_json=?, indoor=?, visit_weight=?, updated_at=? WHERE id=?
    `).run(next.name, next.kind, next.city, next.region, next.country, next.time_zone, next.lat, next.lng, next.tags_json, next.indoor, next.visit_weight, next.updated_at, id);
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

  /** Unique locations visited in the last `hours`, for anti-repeat. */
  recentlyVisitedLocationIds(hours: number): string[] {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
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
}
