import { getToken } from './api.js';

function authHeaders(): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  const token = getToken();
  if (token) headers.set('x-sooya-token', token);
  return headers;
}

export async function requestPushApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: init.headers ?? authHeaders() });
  const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `通知请求失败 (${response.status})`);
  return body as T;
}
