import { ApiError } from './api.js';
import { getAdminToken } from './admin.js';
import { credentialFreeMediaPath } from './authenticatedMedia.js';

export interface FeatureMedia {
  id: string;
  kind: string;
  mime: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  url: string;
  name?: string | null;
  origin: 'upload' | 'generated' | 'builtin' | 'remote';
  exists: boolean;
  createdAt: string;
  deletedAt?: string | null;
  favorite: boolean;
  tags: string[];
  meta?: Record<string, unknown>;
  references?: { total: number; messages?: number; stickers?: number };
}

export interface LifeSnapshot {
  activity: string;
  kind: string;
  mood: string;
  startedAt: string;
  endsAt: string;
  recent: Array<{ activity: string; startedAt: string; endedAt: string }>;
}

export interface LifeSettings {
  reachOut: boolean;
  quietGapMinutes: number;
  maxReachOutsPerDay: number;
  silentFrom: number;
  silentTo: number;
  tzOffsetMinutes: number;
}

export interface LifeLogRow {
  id: string;
  activity: string;
  kind: string;
  mood: string;
  started_at: string;
  ended_at: string;
  shared: number;
}

export interface LifePanelData {
  snapshot: LifeSnapshot;
  log: LifeLogRow[];
  reachOut: {
    reach: boolean;
    reason: string;
    candidate: { id: string; activity: string; endedAt: string } | null;
    sharedLastDay: number;
    lastUserAt: string | null;
    lastAssistantAt: string | null;
    enabledByDeployment: boolean;
  };
  settings: LifeSettings;
}

export interface WorldEntry {
  id: string;
  kind: 'entity' | 'relation' | 'fact' | 'scene' | 'timeline';
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  authority: 'model' | 'user' | 'admin';
  active: number | boolean;
  conflict_of?: string | null;
  source_message_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

async function request<T>(path: string, options: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const headers = new Headers();
  const token = getAdminToken();
  if (token) headers.set('x-admin-token', token);
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const response = await fetch(path, { method: options.method ?? 'GET', headers, body });
  if (options.raw && response.ok) return (await response.blob()) as T;
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (!response.ok) {
    const message = (parsed as { message?: string; error?: string })?.message ?? (parsed as { error?: string })?.error ?? `request failed (${response.status})`;
    throw new ApiError(message, response.status, parsed);
  }
  return parsed as T;
}

function params(input: Record<string, string | number | boolean | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '') out.set(key, String(value));
  const query = out.toString();
  return query ? `?${query}` : '';
}

export const featureApi = {
  uploadAvatar: (slot: 'assistant' | 'user', file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{ persona: { avatar: string; userAvatar: string }; media: FeatureMedia }>(`/api/admin/persona/avatar/${slot}`, { method: 'POST', body: form });
  },

  gallery: (query: { trash?: boolean; origin?: string; favorite?: boolean; search?: string; from?: string; to?: string; limit?: number; offset?: number } = {}) =>
    request<{ media: FeatureMedia[]; stats: { count: number; bytes: number }; total: number }>(`/api/admin/gallery${params(query)}`),
  patchMedia: (id: string, patch: { favorite?: boolean; tags?: string[] }) => request<{ media: FeatureMedia }>(`/api/admin/media/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  trashMedia: (id: string) => request<{ trashed: boolean }>(`/api/admin/media/${encodeURIComponent(id)}/trash`, { method: 'POST' }),
  restoreMedia: (id: string) => request<{ restored: boolean }>(`/api/admin/media/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  deleteMedia: (id: string) => request<{ deleted: boolean }>(`/api/admin/media/${encodeURIComponent(id)}/permanent`, { method: 'DELETE' }),
  batchMedia: (ids: string[], action: 'trash' | 'restore' | 'favorite' | 'unfavorite' | 'permanent') =>
    request<{ changed: number; blocked: Array<{ id: string; reason: string }>; missing: string[] }>('/api/admin/media/batch', { method: 'POST', body: { ids, action } }),

  voice: () => request<Record<string, any>>('/api/admin/voice'),
  updateVoice: async (body: Record<string, unknown>) => {
    await request('/api/admin/voice', { method: 'PUT', body });
    return request<Record<string, any>>('/api/admin/voice');
  },
  previewVoice: (text: string, emotion: string) => request<Blob>('/api/admin/voice/preview', { method: 'POST', body: { text, emotion }, raw: true }),

  life: () => request<LifePanelData>('/api/admin/life'),
  updateLifeSettings: (body: Partial<LifeSettings>) =>
    request<{ settings: LifeSettings }>('/api/admin/life/settings', { method: 'PUT', body }),
  tickLife: () => request<{ changed: boolean; activity: string; snapshot: LifeSnapshot }>('/api/admin/life/tick', { method: 'POST' }),

  world: (query: { search?: string; kind?: string; active?: boolean; limit?: number; offset?: number } = {}) =>
    request<{ entries: WorldEntry[]; total: number }>(`/api/admin/world${params(query)}`),
  createWorld: (entry: Omit<WorldEntry, 'id' | 'active' | 'confidence' | 'authority'> & Partial<Pick<WorldEntry, 'confidence' | 'authority'>>) =>
    request<{ entry: WorldEntry }>('/api/admin/world', { method: 'POST', body: entry }),
  updateWorld: (id: string, patch: Partial<WorldEntry>) => request<{ entry: WorldEntry }>(`/api/admin/world/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  deleteWorld: (id: string) => request<{ deleted: true }>(`/api/admin/world/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  rebuildWorld: (limit = 400) => request<Record<string, unknown>>('/api/admin/world/rebuild', { method: 'POST', body: { limit } }),
  exportWorld: () => request<Record<string, unknown>>('/api/admin/world/export'),
  importWorld: (data: unknown) => request<Record<string, unknown>>('/api/admin/world/import', { method: 'POST', body: data }),

  storage: () => request<Record<string, any>>('/api/admin/storage'),
  updateStorage: (body: Record<string, number>) => request<Record<string, any>>('/api/admin/storage/policy', { method: 'PUT', body }),
  cleanupStorage: (apply: boolean, categories?: string[], reportId?: string) =>
    request<Record<string, any>>('/api/admin/storage/cleanup', { method: 'POST', body: { apply, categories, reportId } }),
  audit: () => request<{ audit: Array<Record<string, unknown>> }>('/api/admin/audit')
};

export function adminMediaUrl(url: string): string {
  return credentialFreeMediaPath(url);
}
