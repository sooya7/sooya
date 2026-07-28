import { ApiError } from './api.js';

const ADMIN_TOKEN_KEY = 'sooya.admin-token';

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string): void {
  try {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
  } catch {
    /* private mode */
  }
}

export function clearAdminToken(): void {
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* private mode */
  }
}

async function adminRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: HeadersInit } = {}
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

  const res = await fetch(path, { method: options.method ?? 'GET', headers, body });
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
  speakingStyle: string;
  relationshipContext: string;
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

export const adminApi = {
  system: () => adminRequest<AdminSystemStatus>('/api/admin/system'),
  capabilities: () => adminRequest<AdminCapabilities>('/api/admin/capabilities'),
  persona: () => adminRequest<{ persona: AdminPersona }>('/api/admin/persona'),
  updatePersona: (patch: Partial<AdminPersona>) =>
    adminRequest<{ persona: AdminPersona }>('/api/admin/persona', { method: 'PUT', body: patch }),
  models: () => adminRequest<{ models: AdminModels }>('/api/admin/models'),
  updateModels: (patch: AdminModels) =>
    adminRequest<{ models: AdminModels }>('/api/admin/models', { method: 'PUT', body: patch }),
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
  memories: () => adminRequest<{ memories: AdminMemory[]; stats: Record<string, unknown> }>('/api/admin/memories'),
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
    adminRequest<{ deleted: boolean }>(`/api/admin/backups/${encodeURIComponent(name)}`, { method: 'DELETE' })
};
