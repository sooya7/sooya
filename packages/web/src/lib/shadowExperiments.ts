import { ApiError } from './api.js';

const ADMIN_TOKEN_KEY = 'sooya.admin-token';

function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

async function adminRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const headers = new Headers();
  const token = getAdminToken();
  if (token) headers.set('X-Admin-Token', token);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');

  const res = await fetch(path, { method: options.method ?? 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
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

export interface ShadowRun {
  id: string;
  subsystem: string;
  canonical_version: string;
  shadow_version: string;
  input_fingerprint: string;
  canonical_decision: string;
  shadow_decision: string;
  diff_json: string;
  duration_ms: number;
  created_at: string;
}

export interface Experiment {
  id: string;
  name: string;
  subsystem: string;
  variants_json: string;
  status: 'draft' | 'shadow' | 'running' | 'paused' | 'completed' | 'cancelled';
  assignment_scope: 'day' | 'session' | 'conversation';
  created_at: string;
  updated_at: string;
  variants?: string[];
  currentVariant?: string | null;
}

export const shadowApi = {
  runs: (subsystem?: string, limit = 100) =>
    adminRequest<{ runs: ShadowRun[] }>(`/api/admin/shadow-runs?limit=${limit}${subsystem ? `&subsystem=${encodeURIComponent(subsystem)}` : ''}`),
  experiments: () => adminRequest<{ experiments: Experiment[] }>('/api/admin/experiments'),
  createExperiment: (input: { name: string; subsystem: string; variants: string[]; assignmentScope?: string }) =>
    adminRequest<{ experiment: Experiment }>('/api/admin/experiments', { method: 'POST', body: input }),
  setExperimentStatus: (id: string, status: string) =>
    adminRequest<{ experiment: Experiment }>(`/api/admin/experiments/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } }),
  experimentEvents: (id: string) =>
    adminRequest<{ events: Array<{ id: string; experiment_id: string; variant: string; event: string; created_at: string }> }>(`/api/admin/experiments/${encodeURIComponent(id)}/events`)
};
