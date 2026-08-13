import { ApiError } from './api.js';
import { clearMediaCache } from './authenticatedMedia.js';
import type { ModelPreset, ModelSlot } from './modelPresets.js';
import type { WorldPresence } from './types.js';

const ADMIN_TOKEN_KEY = 'sooya.admin-token';
export const ADMIN_UNAUTHORIZED_EVENT = 'sooya:admin-unauthorized';

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

/**
 * 任何管理接口发现令牌失效时都走同一个出口，让当前子页立即回到登录壳。
 * 这不能依赖概览请求，因为头像、语音等子页会独立加载自己的数据。
 */
export function invalidateAdminSession(failedToken: string | null = getAdminToken()): boolean {
  // 旧请求可能在用户重新登录后才返回；不能让旧 401 清掉刚换上的新令牌。
  if (getAdminToken() !== failedToken) return false;
  clearAdminToken();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ADMIN_UNAUTHORIZED_EVENT));
  return true;
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

export async function adminRequest<T>(
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
    if (res.status === 401 || res.status === 403) invalidateAdminSession(token);
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

export type AdminWebSearchProvider = 'doubao' | 'tavily' | 'responses';

export interface AdminWebSearchConfig {
  enabled: boolean;
  providers: AdminWebSearchProvider[];
  maxResults: number;
  timeoutMs: number;
  doubao: {
    edition: 'custom' | 'global';
    baseUrl: string;
    apiKeyConfigured?: boolean;
    apiKey?: string;
  };
  tavily: {
    baseUrl: string;
    apiKeyConfigured?: boolean;
    apiKey?: string;
  };
}

export interface WebSearchTestResult {
  ok: true;
  provider: AdminWebSearchProvider;
  latencyMs: number;
  resultCount: number;
}

export type AdminModels = Record<string, Record<string, unknown> | AdminWebSearchConfig | number | undefined>;

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
  animated?: boolean;
  origin: string;
  exists: boolean;
  createdAt: string;
  name?: string | null;
  deletedAt?: string | null;
  favorite?: boolean;
  tags?: string[];
  usageCount?: number;
  references?: Record<string, number>;
  avatar?: boolean;
}

export interface AdminSticker {
  id: string;
  name: string;
  tags: string[];
  emotion: string;
  enabled: boolean;
  useCount: number;
  assistantUseCount?: number;
  assistantLastUsedAt?: string | null;
  userUseCount?: number;
  description?: string | null;
  imageText?: string | null;
  userMeaning?: string | null;
  analysisStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  analysisSource?: 'ai' | 'manual' | 'legacy';
  analysisError?: string | null;
  analysisVersion?: number;
  hasEmbedding?: boolean;
  url: string;
  animated?: boolean;
  available?: boolean;
  mime?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AdminMcpServer {
  id: string;
  enabled: boolean;
  url: string;
  transport: string;
  authConfigured: boolean;
  required: boolean;
  state: string;
  toolCount: number;
  latencyMs?: number;
  lastConnected?: string;
  lastRefresh?: string;
  lastConnectedAt?: string;
  lastRefreshAt?: string;
  lastError?: string;
}

export interface AdminMcpTool {
  name: string;
  modelName?: string;
  remoteName?: string;
  serverId?: string;
  description: string;
  risk: string;
  phases: string[];
  authorized: boolean;
}

export interface AdminMcpOverview {
  configSource: string;
  globalPolicy: Record<string, boolean>;
  servers: AdminMcpServer[];
  tools: AdminMcpTool[];
  memory: AdminOmbreStatus;
  dashboardUrl: string | null;
}

export interface AdminOmbreStatus {
  backend: 'ombre';
  connection: 'connected' | 'degraded';
  health: Record<string, unknown> | null;
  lastCommit: Record<string, unknown> | null;
  pending: number;
  uncertain: number;
  lastDream: string | null;
  dashboardUrl: string | null;
}

export interface AdminActivityItem {
  id: string;
  seq: number;
  type: string;
  createdAt: string;
  detail: Record<string, unknown>;
}

export interface AdminChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  createdAt: string;
  updatedAt: string;
  seq: number;
  status: string;
  content: Array<{ id: string; type: string; text?: string | null; transcript?: string | null; media?: { id: string; kind: string; url: string; mime: string } | null }>;
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
export interface AdminLifeLocation { id: string; name: string; kind: string; cityId?: string | null; city?: string | null; region?: string | null; country?: string | null; timeZone?: string | null; lat?: number | null; lng?: number | null; tags: string[]; indoor: boolean; visitWeight: number; source: string; active: boolean; }
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

export type WeatherCondition = 'clear' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog' | 'wind' | 'unknown';

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
  currentSource: string | null;
  lastSnapshot: WeatherSnapshot | null;
  cacheAgeSec: number | null;
  daylight: DaylightSnapshot | null;
  forecast: WeatherForecastSummary | null;
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

export const adminApi = {
  system: () => adminRequest<AdminSystemStatus>('/api/admin/system'),
  capabilities: () => adminRequest<AdminCapabilities>('/api/admin/capabilities'),
  persona: () => adminRequest<{ persona: AdminPersona }>('/api/admin/persona'),
  updatePersona: (patch: Partial<AdminPersona>) =>
    adminRequest<{ persona: AdminPersona }>('/api/admin/persona', { method: 'PUT', body: patch }),
  /** Voice-system convergence §4.1: the only two behavior knobs left in the panel. */
  voiceBehavior: () => adminRequest<{ enabled: boolean; maxVoiceSeconds: number }>('/api/admin/voice-behavior'),
  updateVoiceBehavior: (patch: { enabled?: boolean; maxVoiceSeconds?: number }) =>
    adminRequest<{ enabled: boolean; maxVoiceSeconds: number }>('/api/admin/voice-behavior', { method: 'PUT', body: patch }),
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
  lifeLocations: () => adminRequest<{ locations: AdminLifeLocation[]; current: AdminLifeLocation | null }>('/api/admin/life/locations'),
  createLocation: (input: { name: string; kind: string; tags?: string[]; indoor?: boolean; visitWeight?: number }) =>
    adminRequest<{ location: AdminLifeLocation }>('/api/admin/life/locations', { method: 'POST', body: input }),
  deleteLocation: (id: string) => adminRequest<{ ok: true }>(`/api/admin/life/locations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  overrideLocation: (locationId: string, reason: string) =>
    adminRequest<{ location: AdminLifeLocation; presence?: WorldPresence }>('/api/admin/life/location/override', { method: 'POST', body: { locationId, reason } }),
  proactiveAttempts: () => adminRequest<{ attempts: AdminProactiveAttempt[] }>('/api/admin/life/proactive'),
  stickers: (opts: { q?: string; status?: string; enabled?: boolean; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.status) params.set('status', opts.status);
    if (opts.enabled !== undefined) params.set('enabled', String(opts.enabled));
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    const query = params.toString();
    return adminRequest<{ stickers: AdminSticker[]; total: number; offset: number; facets?: { status: Record<string, number>; source: Record<string, number>; emotion: Record<string, number> }; analysisVersion?: number }>(`/api/admin/stickers${query ? `?${query}` : ''}`);
  },
  adminStickers: (opts: { q?: string; status?: string; source?: string; emotion?: string; enabled?: boolean; sort?: 'created' | 'name' | 'recent' | 'usage'; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts)) if (value !== undefined && value !== '') params.set(key, String(value));
    const query = params.toString();
    return adminRequest<{ stickers: AdminSticker[]; total: number; offset: number; facets: { status: Record<string, number>; source: Record<string, number>; emotion: Record<string, number> }; analysisVersion?: number }>(`/api/admin/stickers${query ? `?${query}` : ''}`);
  },
  uploadSticker: (body: FormData) =>
    adminRequest<{ created: AdminSticker[]; failed: Array<{ filename: string; error: string }> }>('/api/admin/stickers', {
      method: 'POST',
      body
    }),
  updateSticker: (id: string, patch: Partial<Pick<AdminSticker, 'name' | 'tags' | 'emotion' | 'enabled' | 'description' | 'imageText' | 'userMeaning'>> & { userMeaningSource?: 'none' | 'ai' | 'manual'; favorite?: boolean }) =>
    adminRequest<{ sticker: AdminSticker }>(`/api/admin/stickers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch
    }),
  analyzeSticker: (id: string, force = false) =>
    adminRequest<{ queued: boolean; jobId: string; stickerId: string }>(`/api/admin/stickers/${encodeURIComponent(id)}/analyze`, { method: 'POST', body: force ? { force: true } : {} }),
  analyzeStickerBatch: (body: { mode?: 'missing_or_stale' | 'selected'; ids?: string[] } = {}) =>
    adminRequest<{ queued: number; skipped: number }>('/api/admin/stickers/analyze-batch', { method: 'POST', body }),
  deleteSticker: (id: string) =>
    adminRequest<{ deleted: boolean }>(`/api/admin/stickers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  modelPresets: () => adminRequest<{ presets: ModelPreset[]; slots: ModelSlot[] }>('/api/admin/model-presets'),
  addModelPreset: (preset: ModelPreset) =>
    adminRequest<{ preset: ModelPreset }>('/api/admin/model-presets/from-current', { method: 'POST', body: { preset } }),
  discoverModels: (slot: ModelSlot, baseUrl?: string) =>
    adminRequest<{ models: string[]; source: string }>(
      `/api/admin/models/${encodeURIComponent(slot)}/discover`,
      { method: 'POST', body: { ...(baseUrl ? { baseUrl } : {}) } }
    ),
  testModel: (slot: ModelSlot, forceImage = false) =>
    adminRequest<ModelTestResult>(`/api/admin/models/${encodeURIComponent(slot)}/test`, { method: 'POST', body: forceImage ? { force: true } : {} }),
  testWebSearch: (provider: AdminWebSearchProvider, query: string) =>
    adminRequest<WebSearchTestResult>('/api/admin/models/web-search/test', { method: 'POST', body: { provider, query } }),
  saveModelPresets: (presets: ModelPreset[]) =>
    adminRequest<{ presets: ModelPreset[] }>('/api/admin/model-presets', { method: 'PUT', body: { presets } }),
  applyModelPreset: (id: string) =>
    adminRequest<{ applied: string; models: AdminModels }>(
      `/api/admin/model-presets/${encodeURIComponent(id)}/apply`,
      { method: 'POST' }
    ),
  memories: () => adminRequest<{ memories: AdminMemory[]; stats: Record<string, unknown>; recall?: AdminRecallTrace }>('/api/admin/memories'),
  mcpOverview: () => adminRequest<{ configSource: string; globalPolicy: Record<string, boolean>; servers: AdminMcpServer[]; tools: AdminMcpTool[]; memory: AdminOmbreStatus; dashboardUrl: string | null }>('/api/admin/mcp/servers'),
  mcpToolSchema: (name: string) => adminRequest<{ tool: AdminMcpTool & { inputSchema: Record<string, unknown> } }>(`/api/admin/mcp/tools/${encodeURIComponent(name)}`),
  testMcpServer: (id: string) => adminRequest<{ ok: boolean; server: AdminMcpServer }>(`/api/admin/mcp/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  refreshMcpTools: (id: string) => adminRequest<{ ok: boolean; server: AdminMcpServer }>(`/api/admin/mcp/${encodeURIComponent(id)}/refresh-tools`, { method: 'POST' }),
  ombreStatus: () => adminRequest<AdminOmbreStatus>('/api/admin/memory/status'),
  ombreSearch: (query: string, limit = 10) => adminRequest<{ query: string; results: Array<Record<string, unknown>>; raw: string; resultCount: number }>(`/api/admin/memory/ombre/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  ombreCatalog: (limit = 50) => adminRequest<Record<string, unknown>>(`/api/admin/memory/ombre/catalog?limit=${limit}`),
  ombreActivity: (limit = 50) => adminRequest<{ activity: AdminActivityItem[] }>(`/api/admin/memory/activity?limit=${limit}`),
  legacyMemories: (limit = 100, offset = 0) => adminRequest<{ memories: AdminMemory[]; total: number; readOnly: true }>(`/api/admin/memory/legacy?limit=${limit}&offset=${offset}`),
  deleteMemory: (id: string) =>
    adminRequest<{ deleted: boolean }>(`/api/admin/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearMemories: () => adminRequest<{ cleared: boolean }>('/api/admin/memories/clear', { method: 'POST' }),
  media: () => adminRequest<{ media: AdminMedia[]; total: number }>('/api/admin/media'),
  adminMedia: (opts: { q?: string; kind?: string; origin?: string; state?: 'active' | 'trashed' | 'all'; sort?: 'created' | 'size' | 'usage'; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts)) if (value !== undefined && value !== '') params.set(key, String(value));
    const query = params.toString();
    return adminRequest<{ media: AdminMedia[]; total: number; offset: number }>(`/api/admin/media${query ? `?${query}` : ''}`);
  },
  mediaUsage: (id: string) => adminRequest<{ mediaId: string; usageCount: number; references: Record<string, number>; avatar: boolean }>(`/api/admin/media/${encodeURIComponent(id)}/usage`),
  mediaDetail: (id: string) => adminRequest<{ media: AdminMedia & { tags: string[]; meta: Record<string, unknown>; references: Record<string, number>; usageCount: number; avatar: boolean } }>(`/api/admin/media/${encodeURIComponent(id)}`),
  chatHistory: (opts: { q?: string; from?: string; to?: string; role?: 'user' | 'assistant'; hasMedia?: boolean; mediaKind?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts)) if (value !== undefined && value !== '') params.set(key, String(value));
    const query = params.toString();
    return adminRequest<{ messages: AdminChatMessage[]; total: number; limit: number; offset: number; hasMore: boolean }>(`/api/admin/chat/history${query ? `?${query}` : ''}`);
  },
  chatContext: (id: string, before = 10, after = 10) => adminRequest<{ target: AdminChatMessage; messages: AdminChatMessage[]; hasOlder: boolean; hasNewer: boolean }>(`/api/admin/chat/history/${encodeURIComponent(id)}/context?before=${before}&after=${after}`),
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
  /* ---- Next phase (frozen contract §2): life cities / travel ---- */
  lifeCities: () => adminRequest<{ cities: LifeCity[] }>('/api/admin/life/cities'),
  // 产品范围：中国城市、统一 Asia/Shanghai——country/timeZone 由服务端固定。
  createCity: (input: { name: string; region?: string }) =>
    adminRequest<{ city: LifeCity }>('/api/admin/life/cities', { method: 'POST', body: input }),
  updateCity: (id: string, patch: Partial<Pick<LifeCity, 'name' | 'region' | 'active'>>) =>
    adminRequest<{ city: LifeCity }>(`/api/admin/life/cities/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  lifeTravel: () => adminRequest<{ travel: TravelState | null }>('/api/admin/life/travel'),
  /* ---- Next phase: weather ---- */
  weatherStatus: () => adminRequest<WeatherStatus>('/api/admin/weather/status'),
  weatherForecast: () => adminRequest<{ forecast: WeatherForecastSummary | null }>('/api/admin/weather/forecast'),
  weatherRefresh: () => adminRequest<{ ok: true; snapshot: WeatherSnapshot | null; presence: WorldPresence }>('/api/admin/weather/refresh', { method: 'POST' }),
  /* ---- Next phase: metrics ---- */
  metrics: (days: number) => adminRequest<{ aggregates: MetricAggregate[] }>(`/api/admin/metrics?days=${days}`),
  metricsDistributions: (days: number) =>
    adminRequest<{ distributions: MetricsDistribution[] }>(`/api/admin/metrics/distributions?days=${days}`),

};
