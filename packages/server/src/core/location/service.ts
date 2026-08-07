import type { LifeLocationRepo, LifeLocation, LifeLocationStateRow, LocationKind } from '../../db/repos/location.repo.js';
import { toLifeLocation } from '../../db/repos/location.repo.js';
import type { AuditRepo } from '../../db/repos/feature.repo.js';
import { scoreLocationCandidates, KIND_LABELS, type LocationSelection } from './selector.js';
import type { LifeActivityDefinition } from '../life2/activities.js';

/**
 * LocationService (next phase): owns SOOYA's own life location — where she
 * is, how she got there, where she is going. Everything is gated behind
 * LOCATION_MODEL_ENABLED; when the flag is off the service is inert and the
 * chat/life behavior is identical to the stable release.
 */

interface BuiltinSeed {
  name: string;
  kind: LocationKind;
  tags: string[];
  indoor: boolean;
}

const BUILTIN_SEEDS: BuiltinSeed[] = [
  { name: '家', kind: 'home', tags: ['home', 'cozy', 'rest'], indoor: true },
  { name: '家附近', kind: 'neighborhood', tags: ['home', 'out', 'walk'], indoor: false },
  { name: '街角咖啡店', kind: 'cafe', tags: ['cafe', 'drink', 'solo'], indoor: true },
  { name: '社区公园', kind: 'park', tags: ['park', 'out', 'walk'], indoor: false },
  { name: '图书馆', kind: 'library', tags: ['library', 'study', 'quiet'], indoor: true },
  { name: '小区超市', kind: 'store', tags: ['store', 'errand', 'shopping'], indoor: true }
];

/** Default travel edges between the builtin seeds (walking city). */
const BUILTIN_EDGES: Array<[string, string, number, 'walk' | 'bike']> = [
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

export class LocationService {
  private enabled = false;

  constructor(
    private readonly repo: LifeLocationRepo,
    private readonly audit: AuditRepo,
    private readonly clock: () => Date = () => new Date(),
    /** Optional next-phase weather condition getter (cached, never blocks). */
    private readonly weatherConditionFor?: (location: LifeLocation | null) => string | null,
    /** Next-phase shadow runtime (SHADOW_MODE_ENABLED). */
    private readonly shadow?: import('../shadow.js').ShadowService
  ) {}

  /** Flag wiring: LOCATION_MODEL_ENABLED (master WORLD_CONTEXT_ENABLED too). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.seedBuiltins();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** One-time builtin seed; admin edits never get overwritten. */
  private seedBuiltins(): void {
    if (this.repo.list(false).length > 0) return;
    const byName = new Map<string, string>();
    for (const seed of BUILTIN_SEEDS) {
      const row = this.repo.create({ ...seed, source: 'builtin' });
      byName.set(seed.name, row.id);
    }
    for (const [from, to, minutes, mode] of BUILTIN_EDGES) {
      const fromId = byName.get(from);
      const toId = byName.get(to);
      if (fromId && toId) this.repo.saveEdge(fromId, toId, minutes, mode);
    }
  }

  list(): LifeLocation[] {
    return this.repo.list(true).map(toLifeLocation);
  }

  get(id: string): LifeLocation | undefined {
    const row = this.repo.get(id);
    return row ? toLifeLocation(row) : undefined;
  }

  current(): LifeLocation | null {
    if (!this.enabled) return null;
    const state = this.repo.currentState();
    if (!state) return null;
    const row = this.repo.get(state.location_id);
    return row && row.active === 1 ? toLifeLocation(row) : null;
  }

  currentState(): LifeLocationStateRow | null {
    if (!this.enabled) return null;
    return this.repo.currentState() ?? null;
  }

  /** Home is the implicit baseline before any location state exists. */
  private homeLocation(): LifeLocation | null {
    const row = this.repo.list(true).find((l) => l.kind === 'home');
    return row ? toLifeLocation(row) : null;
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

  /**
   * Called by the life engine after an activity resolves. Moves SOOYA when
   * the activity has a location affinity and the best candidate differs from
   * her current location; records the visit and travel state.
   */
  onActivityResolved(def: LifeActivityDefinition | null | undefined, kind: string, planId: string | null, activityId: string | null): LocationSelection | null {
    if (!this.enabled) return null;
    const now = this.clock();
    const current = this.repo.currentState();
    const weatherCondition = this.weatherConditionFor?.(this.current() ?? this.homeLocation()) ?? null;
    const selection = scoreLocationCandidates(
      this.repo.list(true),
      {
        def: def ?? null,
        kind,
        currentLocationId: current?.location_id ?? null,
        recentVisitIds: this.repo.recentlyVisitedLocationIds(24),
        repeatWindowHours: 24,
        threadTags: [],
        hour: now.getUTCHours() + 8 % 24, // local-hour approximation for selection
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
          recentVisitIds: this.repo.recentlyVisitedLocationIds(24),
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
              recentVisitIds: this.repo.recentlyVisitedLocationIds(24),
              repeatWindowHours: 24,
              threadTags: [],
              hour: now.getUTCHours() + 8 % 24,
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

    // Leaving the previous location: close its open visit.
    if (current) this.repo.closeOpenVisits(current.location_id, now.toISOString());
    this.repo.setState({
      locationId: selection.locationId,
      arrivedAt: now.toISOString(),
      sourcePlanId: planId,
      sourceActivityId: activityId,
      confidence: 0.9
    });
    this.repo.recordVisit({
      locationId: selection.locationId,
      enteredAt: now.toISOString(),
      sourcePlanId: planId,
      sourceActivityId: activityId
    });
    return selection;
  }

  /** Admin override: moves SOOYA immediately; every override is audited. */
  override(locationId: string, reason: string): LifeLocation | null {
    const location = this.get(locationId);
    if (!location || !location.active) return null;
    const now = this.clock();
    const current = this.repo.currentState();
    if (current) this.repo.closeOpenVisits(current.location_id, now.toISOString());
    this.repo.setState({ locationId, arrivedAt: now.toISOString(), confidence: 1 });
    this.repo.recordVisit({ locationId, enteredAt: now.toISOString() });
    this.audit.add('life.location', 'override', locationId, { reason, from: current?.location_id ?? null });
    return location;
  }

  /** Current location + a label line for the prompt (known facts only). */
  contextLines(): string[] {
    if (!this.enabled) return [];
    const current = this.current();
    if (!current) return [];
    const label = KIND_LABELS[current.kind] ?? current.kind;
    const lines = [`你现在在${current.name}（${label}）。`];
    lines.push('这是你真实的位置，被问起就照实说，不要编造具体地址。');
    return lines;
  }
}
