import { ApiError } from './api.js';
import { clearMediaCache } from './authenticatedMedia.js';
import type { ModelPreset, ModelSlot } from './modelPresets.js';

const ADMIN_TOKEN_KEY = 'sooya.admin-token';

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string): void {
  const changed = getAdminToken() !== token;
  try {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
  } catch {
    /* private mode */
  }
  if (changed) clearMediaCache('admin');
}

export function clearAdminToken(): void {
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* private mode */
  }
  clearMediaCache('admin');
}

export type AdminFailureKind = 'unauthorized' | 'flag-disabled' | 'provider-unconfigured' | 'error';

/**
 * UI convention for backend "not ready" states (see INTEGRATION-NOTES-ui.md):
 * HTTP 401/403 → unauthorized; a message mentioning an ENABLED flag or
 * "未启用" → flag-disabled; a message mentioning provider config or "未配置" →
 * provider-unconfigured; everything else is a plain error.
 */
export function adminFailureKind(error: unknown): AdminFailureKind {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return 'unauthorized';
    const text = String(error.message ?? '');
    if (/disabled|未启用|not enabled|ENABLED/i.test(text)) return 'flag-disabled';
    if (/configured|未配置|no provider|provider/i.test(text)) return 'provider-unconfigured';
  }
  return 'error';
}

async function adminRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: HeadersInit; signal?: AbortSignal } = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getAdminToken();
  if (token) headers.set('X-Admin-Token', token);

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const res = await fetch(path, { method: options.method ?? 'GET', headers, body, signal: options.signal });
  const text = await res.text();
  let responseBody: unknown = null;
  if (text) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  }
  if (!res.ok) {
    const message =
      (responseBody as { message?: string; error?: string })?.message ??
      (responseBody as { error?: string })?.error ??
      `request failed (${res.status})`;
    throw new ApiError(message, res.status, responseBody);
  }
  return responseBody as T;
}

export interface AdminSystemStatus {
  version: string;
  startedAt: string;
  uptimeSec: number;
  node: string;
  platform: string;
  memoryMb: number;
  loadAvg: number[];
  database: Record<string, unknown>;
  storage: Record<string, unknown>;
  stream: Record<string, unknown>;
  agent: Record<string, unknown>;
}

export interface AdminCapabilities {
  capabilities: Record<string, unknown>;
  embeddingDimensions: number | null;
}

export interface AdminBackup {
  name: string;
  path: string;
  bytes: number;
  createdAt: string;
  sha256: string;
  verified: boolean;
  mediaArchived: boolean;
}

export interface AdminPersona {
  id: string;
  name: string;
  avatar: string;
  userAvatar: string;
  tagline: string;
  systemPrompt: string;
  language: string;
  stickerPolicy: Record<string, unknown>;
  voicePolicy: Record<string, unknown>;
  imagePolicy: Record<string, unknown>;
}

export type AdminModels = Record<string, Record<string, unknown> | undefined>;

export interface AdminMemory {
  id: string;
  kind: string;
  content: string;
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  hits: number;
  hasEmbedding: boolean;
}

export interface AdminRecallTraceEntry {
  id: string;
  kind: string;
  content: string;
  sources: string[];
  strategy: string;
  score: number | null;
  reason: string;
  included: boolean;
  droppedReason?: string;
}

export interface AdminRecallTrace {
  query: string;
  strategy: string;
  fallbackReason?: string;
  entries: AdminRecallTraceEntry[];
  stats: { recalled: number; included: number; deduplicated: number; budgetDropped: number };
}

export interface AdminMedia {
  id: string;
  kind: string;
  mime: string;
  bytes: number;
  url: string;
  origin: string;
  exists: boolean;
  createdAt: string;
}

export interface AdminSticker {
  id: string;
  name: string;
  tags: string[];
  emotion: string;
  enabled: boolean;
  useCount: number;
  url: string;
  available?: boolean;
}

export interface AdminError {
  id: string;
  createdAt: string;
  scope: string;
  message: string;
  detail: unknown;
}

/** Reply of a one-shot connectivity probe against the slot's saved config. */
export interface ModelTestResult {
  ok: true;
  slot: ModelSlot;
  provider: string;
  model?: string;
  latencyMs: number;
  detail: string;
}

export interface AdminJob {
  id: string;
  type: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminLifePlan { id: string; title: string; kind: string; status: string; source: string; priority: number; planned_start: string | null; planned_end: string | null; meta_json: string; }
export interface AdminLifeThread { id: string; title: string; category: string; status: string; progress: number; heat: number; next_actions_json: string; meta_json: string; }
export interface AdminLifeVitals { energy: number; hunger: number; stress: number; social_need: number; loneliness: number; curiosity: number; comfort: number; focus: number; sleep_debt: number; }
export interface AdminLifeOverview {
  snapshot: { activity: string; kind: string; mood: string; theme?: string; vitals?: string[] };
  location: { id: string; name: string; kind: string } | null;
  weather: string | null;
  vitals: AdminLifeVitals | null;
  activePlan: { id: string; title: string; kind: string; status: string } | null;
  openThreads: Array<{ id: string; title: string; progress: number }>;
  recentEvents: Array<{ id: string; eventType: string; description: string; happenedAt: string }>;
}
export interface AdminLifeLocation { id: string; name: string; kind: string; tags: string[]; indoor: boolean; visitWeight: number; source: string; active: boolean; }
export interface AdminProactiveAttempt { id: string; candidateId: string | null; status: string; blockedReason: string | null; messageId: string | null; requestedMode: string | null; createdAt: string; }

/* ---- Next phase (frozen contract §1/§2): life cities, travel, weather, ---- */

export type TravelMode = 'walk' | 'bike' | 'transit' | 'car' | 'unknown';

export interface LifeCity {
  id: string;
  name: string;
  region?: string | null;
  country?: string | null;
  timeZone: string;
  active: boolean;
}

export interface TravelState {
  fromLocationId: string;
  toLocationId: string;
  mode: TravelMode;
  startedAt: string;
  expectedArriveAt: string;
}

export type WeatherCondition = 'clear' | 'partly_cloudy' | 'cloudy' | 'rain' | 'drizzle' | 'snow' | 'storm' | 'fog' | 'haze' | 'extreme_heat' | 'extreme_cold' | 'unknown';

export interface WeatherSnapshot {
  observedAt: string;
  condition: WeatherCondition;
  temperatureC?: number;
  feelsLikeC?: number;
  humidity?: number;
  precipitationMm?: number;
  windKph?: number;
  provider: string;
  locationKey: string;
  stale: boolean;
}

export interface WeatherForecastPeriod {
  at: string;
  condition: WeatherCondition;
  temperatureC?: number;
  precipitationMm?: number;
  windKph?: number;
}

export interface WeatherForecastSummary {
  generatedAt: string;
  provider: string;
  next12h: WeatherForecastPeriod[];
  next3d: WeatherForecastPeriod[];
  severe: boolean;
}

export interface DaylightSnapshot {
  sunrise: string;
  sunset: string;
  isDaylight: boolean;
}

/** Response shape of GET /api/admin/weather/status (UI-level contract). */
export interface WeatherStatus {
  enabled: boolean;
  provider: { name: string | null; configured: boolean; active: boolean };
  lastSnapshot: WeatherSnapshot | null;
  cacheAgeSec: number | null;
  fallback: 'primary' | 'secondary' | 'cache' | 'unknown' | null;
  daylight: DaylightSnapshot | null;
  forecast: WeatherForecastSummary | null;
}

export interface GeocodeMatch {
  name: string;
  region?: string | null;
  country?: string | null;
  timeZone?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/* ---- Next phase: metrics ---- */

export interface MetricsDistribution {
  category: string;
  metric: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

export interface MetricAggregate { category: string; metric: string; sum: number; count: number; avg: number; }

export interface ReleaseMetricsComparison {
  current: { from: string; to: string; aggregates: MetricAggregate[] };
  previous: { from: string; to: string; aggregates: MetricAggregate[] };
}

/* ---- Next phase: experiments ---- */

export interface ExperimentReport {
  experimentId: string;
  name: string;
  samples: number;
  control: number;
  treatment: number;
  observedDifference: Array<{ metric: string; control: number; treatment: number }>;
}

export interface ExperimentHistoryEntry {
  id: string;
  experimentId: string;
  event: 'created' | 'shadow' | 'promoted' | 'paused' | 'resumed' | 'completed' | 'config_changed';
  variant: string;
  createdAt: string;
}

/* ---- Next phase: decision trace + visible thoughts ---- */

export type VisibleThoughtKind = 'inner_monologue' | 'decision_summary';
export type VisibleThoughtVisibility = 'user' | 'admin';
export type VisibleThoughtStatus = 'generating' | 'completed' | 'cancelled' | 'failed';

export interface VisibleThought {
  id: string;
  messageId: string;
  batchId: string;
  revision: number;
  kind: VisibleThoughtKind;
  text: string;
  visibility: VisibleThoughtVisibility;
  status: VisibleThoughtStatus;
  createdAt: string;
}

export interface DecisionTrace {
  batchId: string;
  revision: number;
  replyIntent?: string | null;
  lifeContext?: string[] | null;
  weather?: string | null;
  memoryRecallCount?: number | null;
  voiceMode?: string | null;
  semanticGuard?: 'pass' | 'reject' | 'fallback' | null;
  experimentVariant?: string | null;
  proactive?: string | null;
  createdAt: string;
}

export const adminApi = {
  system: () => adminRequest<AdminSystemStatus>('/api/admin/system'),
  capabilities: () => adminRequest<AdminCapabilities>('/api/admin/capabilities'),
  persona: () => adminRequest<{ persona: AdminPersona }>('/api/admin/persona'),
  updatePersona: (patch: Partial<AdminPersona>) =>
    adminRequest<{ persona: AdminPersona }>('/api/admin/persona', { method: 'PUT', body: patch }),
  models: () => adminRequest<{ models: AdminModels }>('/api/admin/models'),
  updateModels: (patch: AdminModels) =>
    adminRequest<{ models: AdminModels }>('/api/admin/models', { method: 'PUT', body: patch }),
  lifeOverview: () => adminRequest<AdminLifeOverview>('/api/admin/life/overview'),
  lifeVitals: () => adminRequest<{ vitals: AdminLifeVitals | null }>('/api/admin/life/vitals'),
  adjustVitals: (field: string, delta: number) =>
    adminRequest<{ vitals: AdminLifeVitals }>('/api/admin/life/vitals/adjust', { method: 'POST', body: { field, delta } }),
  resetVitals: () => adminRequest<{ ok: true }>('/api/admin/life/vitals/reset', { method: 'POST' }),
  lifePlans: () => adminRequest<{ plans: AdminLifePlan[] }>('/api/admin/life/plans'),
  updatePlan: (id: string, patch: Partial<Pick<AdminLifePlan, 'title' | 'status' | 'priority'>> & { plannedStart?: string | null; plannedEnd?: string | null }) =>
    adminRequest<{ plan: AdminLifePlan }>(`/api/admin/life/plans/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  lifeThreads: () => adminRequest<{ threads: AdminLifeThread[] }>('/api/admin/life/threads'),
  updateThread: (id: string, status: string) =>
    adminRequest<{ thread: AdminLifeThread }>(`/api/admin/life/threads/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }),
  lifeEvents: (limit = 50) => adminRequest<{ events: Array<{ id: string; eventType: string; description: string; happenedAt: string; meta_json?: string }> }>(`/api/admin/life/events?limit=${limit}`),
  lifeLocations: () => adminRequest<{ locations: AdminLifeLocation[] }>('/api/admin/life/locations'),
  createLocation: (input: { name: string; kind: string; tags?: string[]; indoor?: boolean; visitWeight?: number }) =>
    adminRequest<{ location: AdminLifeLocation }>('/api/admin/life/locations', { method: 'POST', body: input }),
  deleteLocation: (id: string) => adminRequest<{ ok: true }>(`/api/admin/life/locations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  overrideLocation: (locationId: string, reason: string) =>
    adminRequest<{ location: AdminLifeLocation }>('/api/admin/life/location/override', { method: 'POST', body: { locationId, reason } }),
  proactiveAttempts: () => adminRequest<{ attempts: AdminProactiveAttempt[] }>('/api/admin/life/proactive'),
  stickers: () => adminRequest<{ stickers: AdminSticker[] }>('/api/admin/stickers'),
  uploadSticker: (body: FormData) =>
    adminRequest<{ created: AdminSticker[]; failed: Array<{ filename: string; error: string }> }>('/api/admin/stickers', {
      method: 'POST',
      body
    }),
  updateSticker: (id: string, patch: Partial<Pick<AdminSticker, 'name' | 'tags' | 'emotion' | 'enabled'>>) =>
    adminRequest<{ sticker: AdminSticker }>(`/api/admin/stickers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch
    }),
  deleteSticker: (id: string) =>
    adminRequest<{ deleted: boolean }>(`/api/admin/stickers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  modelPresets: () => adminRequest<{ presets: ModelPreset[]; slots: ModelSlot[] }>('/api/admin/model-presets'),
  discoverModels: (slot: ModelSlot, baseUrl?: string) =>
    adminRequest<{ models: string[]; source: string }>(
      `/api/admin/models/${encodeURIComponent(slot)}/discover`,
      { method: 'POST', body: { ...(baseUrl ? { baseUrl } : {}) } }
    ),
  testModel: (slot: ModelSlot, forceImage = false) =>
    adminRequest<ModelTestResult>(`/api/admin/models/${encodeURIComponent(slot)}/test`, { method: 'POST', body: forceImage ? { force: true } : {} }),
  saveModelPresets: (presets: ModelPreset[]) =>
    adminRequest<{ presets: ModelPreset[] }>('/api/admin/model-presets', { method: 'PUT', body: { presets } }),
  applyModelPreset: (id: string) =>
    adminRequest<{ applied: string; models: AdminModels }>(
      `/api/admin/model-presets/${encodeURIComponent(id)}/apply`,
      { method: 'POST' }
    ),
  memories: () => adminRequest<{ memories: AdminMemory[]; stats: Record<string, unknown>; recall?: AdminRecallTrace }>('/api/admin/memories'),
  deleteMemory: (id: string) =>
    adminRequest<{ deleted: boolean }>(`/api/admin/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearMemories: () => adminRequest<{ cleared: boolean }>('/api/admin/memories/clear', { method: 'POST' }),
  media: () => adminRequest<{ media: AdminMedia[]; total: number }>('/api/admin/media'),
  deleteMedia: (id: string) =>
    adminRequest<{ deleted: boolean }>(`/api/admin/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  errors: () => adminRequest<{ errors: AdminError[] }>('/api/admin/errors'),
  clearErrors: () => adminRequest<{ cleared: boolean }>('/api/admin/errors', { method: 'DELETE' }),
  jobs: () => adminRequest<{ jobs: AdminJob[] }>('/api/admin/jobs'),
  clearChat: () => adminRequest<{ cleared: boolean; messages: number }>('/api/admin/chat/clear', { method: 'POST' }),
  backups: () => adminRequest<{ backups: AdminBackup[] }>('/api/admin/backups'),
  createBackup: () => adminRequest<{ backup: AdminBackup }>('/api/admin/backups', { method: 'POST' }),
  verifyBackup: (name: string) =>
    adminRequest<Record<string, unknown>>(`/api/admin/backups/${encodeURIComponent(name)}/verify`, { method: 'POST' }),
  restoreBackup: (name: string) =>
    adminRequest<Record<string, unknown>>(`/api/admin/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' }),
  deleteBackup: (name: string) =>
    adminRequest<{ deleted: boolean }>(`/api/admin/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /* ---- Next phase (frozen contract §2): life cities / travel / geocode ---- */
  lifeCities: () => adminRequest<{ cities: LifeCity[] }>('/api/admin/life/cities'),
  createCity: (input: { name: string; region?: string; country?: string; timeZone: string }) =>
    adminRequest<{ city: LifeCity }>('/api/admin/life/cities', { method: 'POST', body: input }),
  updateCity: (id: string, patch: Partial<Pick<LifeCity, 'name' | 'region' | 'country' | 'timeZone' | 'active'>>) =>
    adminRequest<{ city: LifeCity }>(`/api/admin/life/cities/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  lifeTravel: () => adminRequest<{ travel: TravelState | null }>('/api/admin/life/travel'),
  geocodeSearch: (query: string) =>
    adminRequest<{ matches: GeocodeMatch[]; provider: string | null; configured: boolean }>('/api/admin/life/geocode/search', { method: 'POST', body: { query } }),
  /* ---- Next phase: weather ---- */
  weatherStatus: () => adminRequest<WeatherStatus>('/api/admin/weather/status'),
  weatherForecast: () => adminRequest<{ forecast: WeatherForecastSummary | null }>('/api/admin/weather/forecast'),
  weatherRefresh: () => adminRequest<{ snapshot: WeatherSnapshot | null }>('/api/admin/weather/refresh', { method: 'POST' }),
  /* ---- Next phase: metrics ---- */
  metrics: (days: number) => adminRequest<{ aggregates: MetricAggregate[] }>(`/api/admin/metrics?days=${days}`),
  metricsDistributions: (days: number) =>
    adminRequest<{ distributions: MetricsDistribution[] }>(`/api/admin/metrics/distributions?days=${days}`),
  metricsReleaseCompare: (from: string, to: string) =>
    adminRequest<ReleaseMetricsComparison>(`/api/admin/metrics/release-compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  /** Downloads the CSV/JSON export; returns the format when the file was saved. */
  metricsExport: async (format: 'csv' | 'json'): Promise<{ ok: true; format: 'csv' | 'json' }> => {
    const headers = new Headers();
    const token = getAdminToken();
    if (token) headers.set('X-Admin-Token', token);
    const res = await fetch(`/api/admin/metrics/export?format=${format}`, { headers });
    if (!res.ok) {
      const text = await res.text();
      const message = (() => { try { const parsed = JSON.parse(text) as { message?: string; error?: string }; return parsed?.message ?? parsed?.error ?? `request failed (${res.status})`; } catch { return text || `request failed (${res.status})`; } })();
      throw new ApiError(message, res.status);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = `sooya-metrics-export.${format}`;
      link.click();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    return { ok: true, format };
  },
  /* ---- Next phase: experiment report / history ---- */
  experimentReport: (id: string) =>
    adminRequest<{ report: ExperimentReport | null }>(`/api/admin/experiments/${encodeURIComponent(id)}/report`),
  experimentHistory: (id: string) =>
    adminRequest<{ history: ExperimentHistoryEntry[] }>(`/api/admin/experiments/${encodeURIComponent(id)}/history`),
  /* ---- Next phase: decision trace / visible thoughts ---- */
  decisionTraces: (limit = 50) => adminRequest<{ traces: DecisionTrace[] }>(`/api/admin/decision-trace/recent?limit=${limit}`),
  decisionTrace: (batchId: string, revision?: number) =>
    adminRequest<{ trace: DecisionTrace }>(
      `/api/admin/decision-trace?batchId=${encodeURIComponent(batchId)}${revision !== undefined ? `&revision=${revision}` : ''}`
    ),
  /** User-visible inner thought for a message (may 404 when none exists). */
  visibleThought: (messageId: string, signal?: AbortSignal) =>
    adminRequest<{ thought: VisibleThought | null }>(`/api/thoughts/${encodeURIComponent(messageId)}`, { signal })
};
