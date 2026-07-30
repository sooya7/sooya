import { getToken } from './api.js';

function authHeaders(): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  const token = getToken();
  if (token) headers.set('x-sooya-token', token);
  return headers;
}

/**
 * `init.headers ?? authHeaders()` used to mean any caller that passed a single custom
 * header silently lost `x-sooya-token` and got an unexplained 401. Merge instead, and
 * let the caller win on a genuine conflict.
 */
export async function requestPushApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders();
  new Headers(init.headers ?? {}).forEach((value, key) => headers.set(key, value));
  const response = await fetch(path, { ...init, headers });
  const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `通知请求失败 (${response.status})`);
  return body as T;
}
