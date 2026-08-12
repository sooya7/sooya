import { ApiError } from './api.js';
import { getAdminToken, invalidateAdminSession } from './admin.js';
import { credentialFreeMediaPath } from './authenticatedMedia.js';

export interface FeatureMedia {
  id: string;
  kind: string;
  mime: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  url: string;
  animated?: boolean;
  name?: string | null;
  origin: 'upload' | 'generated' | 'builtin' | 'remote';
  exists: boolean;
  createdAt: string;
  deletedAt?: string | null;
  favorite: boolean;
  tags: string[];
  meta?: Record<string, unknown>;
  references?: { total: number; messageParts?: number; stickers?: number; moments?: number; voiceGenerations?: number };
}

export interface PersonaReference {
  name: string;
  configured: boolean;
  exists: boolean;
  bytes: number;
  framing: 'side' | 'full-body' | 'front';
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
  proactiveMode?: 'auto' | 'text' | 'text_sticker' | 'voice' | 'image';
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

export type LifePlanStatus = 'planned' | 'active' | 'paused' | 'completed' | 'cancelled' | 'skipped';

export interface LifePlanRow {
  id: string;
  title: string;
  kind: string;
  planned_start: string | null;
  planned_end: string | null;
  status: LifePlanStatus;
  source: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface LifeEventRow {
  id: string;
  plan_id: string | null;
  log_id: string | null;
  event_type: string;
  activity: string;
  kind: string;
  description: string;
  mood_before: string | null;
  mood_after: string | null;
  happened_at: string;
  shareable: number;
  shared_at: string | null;
  created_at: string;
}

export interface ProactiveAttempt {
  id: string;
  candidateId: string | null;
  candidateKind: string | null;
  candidateActivity: string | null;
  status: 'blocked' | 'sent' | 'failed';
  blockedReason: string | null;
  requestedMode: 'text' | 'text_sticker' | 'voice' | 'image' | null;
  finalMode: 'text' | 'text_sticker' | 'voice' | 'image' | null;
  fallbackReason: string | null;
  messageId: string | null;
  momentId?: string | null;
  sendSuccess: boolean;
  userResponseMessageId: string | null;
  userRespondedAt: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LifePanelData {
  snapshot: LifeSnapshot;
  log: LifeLogRow[];
  plans: LifePlanRow[];
  events: LifeEventRow[];
  proactive: ProactiveAttempt[];
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
    if (response.status === 401 || response.status === 403) invalidateAdminSession(token);
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

  references: () => request<{ dir: string | null; references: PersonaReference[] }>('/api/admin/persona/references'),
  uploadReference: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{ reference: PersonaReference; referenceImages: string[] }>('/api/admin/persona/references', { method: 'POST', body: form });
  },
  uploadReferenceSlot: (framing: PersonaReference['framing'], file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<{ reference: PersonaReference; replaced: string[]; referenceImages: string[] }>(`/api/admin/persona/references/slot/${encodeURIComponent(framing)}`, { method: 'POST', body: form });
  },
  deleteReference: (name: string) =>
    request<{ deleted: boolean; removedFile: boolean; referenceImages: string[] }>(`/api/admin/persona/references/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  referenceData: (name: string) =>
    request<Blob>(`/api/admin/persona/references/${encodeURIComponent(name)}/data`, { raw: true }),

  gallery: (query: { trash?: boolean; origin?: string; favorite?: boolean; search?: string; from?: string; to?: string; limit?: number; offset?: number } = {}) =>
    request<{ media: FeatureMedia[]; stats: { count: number; bytes: number }; total: number }>(`/api/admin/gallery${params(query)}`),
  patchMedia: (id: string, patch: { favorite?: boolean; tags?: string[] }) => request<{ media: FeatureMedia }>(`/api/admin/media/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),
  trashMedia: (id: string) => request<{ trashed: boolean }>(`/api/admin/media/${encodeURIComponent(id)}/trash`, { method: 'POST' }),
  restoreMedia: (id: string) => request<{ restored: boolean }>(`/api/admin/media/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  deleteMedia: (id: string) => request<{ deleted: boolean }>(`/api/admin/media/${encodeURIComponent(id)}/permanent`, { method: 'DELETE' }),
  batchMedia: (ids: string[], action: 'trash' | 'restore' | 'favorite' | 'unfavorite' | 'permanent') =>
    request<{ changed: number; blocked: Array<{ id: string; reason: string }>; missing: string[] }>('/api/admin/media/batch', { method: 'POST', body: { ids, action } }),

  /**
   * @deprecated Voice-system convergence: the standalone「情绪语音」panel is
   * gone. Kept for old callers; TTS provider parameters now live in
   * 「模型配置 → 语音合成」 and behavior knobs in「助手配置 → 语音行为」.
   */
  voice: () => request<Record<string, any>>('/api/admin/voice'),
  updateVoice: async (body: Record<string, unknown>) => {
    await request('/api/admin/voice', { method: 'PUT', body });
    return request<Record<string, any>>('/api/admin/voice');
  },
  /** 语音试听：模型配置 → 语音合成 使用；Fish 与 OpenAI/Volc 同样可用。 */
  previewVoice: (text: string, emotion: string) => request<Blob>('/api/admin/voice/preview', { method: 'POST', body: { text, emotion }, raw: true }),

  life: () => request<LifePanelData>('/api/admin/life'),
  createLifePlan: (body: { title: string; kind: string; plannedStart?: string | null; plannedEnd?: string | null; priority?: number }) =>
    request<{ plan: LifePlanRow }>('/api/admin/life/plans', { method: 'POST', body }),
  updateLifePlan: (id: string, body: { status?: LifePlanStatus; title?: string; kind?: string; plannedStart?: string | null; plannedEnd?: string | null; priority?: number }) =>
    request<{ plan: LifePlanRow }>(`/api/admin/life/plans/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  updateLifeSettings: (body: Partial<LifeSettings>) =>
    request<{ settings: LifeSettings }>('/api/admin/life/settings', { method: 'PUT', body }),
  tickLife: () => request<{ changed: boolean; activity: string; snapshot: LifeSnapshot }>('/api/admin/life/tick', { method: 'POST' }),


  storage: () => request<Record<string, any>>('/api/admin/storage'),
  updateStorage: (body: Record<string, number>) => request<Record<string, any>>('/api/admin/storage/policy', { method: 'PUT', body }),
  cleanupStorage: (apply: boolean, categories?: string[], reportId?: string) =>
    request<Record<string, any>>('/api/admin/storage/cleanup', { method: 'POST', body: { apply, categories, reportId } }),
  audit: () => request<{ audit: Array<Record<string, unknown>> }>('/api/admin/audit')
};

export function adminMediaUrl(url: string): string {
  return credentialFreeMediaPath(url);
}
