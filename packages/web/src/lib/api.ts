import type { ChatMessage, LifeState, MediaRef, PersonaInfo, StickerInfo } from './types.js';
import { credentialFreeMediaPath } from './authenticatedMedia.js';

const TOKEN_KEY = 'sooya.token';
export function getToken(): string | null { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
export function setToken(token: string): void { try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ } }
export class ApiError extends Error { constructor(message: string, readonly status: number, readonly body?: unknown) { super(message); this.name = 'ApiError'; } }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('x-sooya-token', token);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!res.ok) { const message = (body as { message?: string; error?: string })?.message ?? (body as { error?: string })?.error ?? `request failed (${res.status})`; throw new ApiError(message, res.status, body); }
  return body as T;
}

export interface ConversationInfo { conversationId: string; persona: PersonaInfo; messageCount: number; lastSeq: number; lastEventSeq: number; }
/** 首屏一次性载荷：会话 + 最新一页消息 + 贴纸 + 她正在做什么。 */
export interface BootstrapInfo { conversation: ConversationInfo; messages: { messages: ChatMessage[]; hasMore: boolean; lastEventSeq: number; lastMessageSeq: number; oldestSeq: number | null }; stickers: StickerInfo[]; life: LifeState; }
export const api = {
  bootstrap: () => request<BootstrapInfo>('/api/bootstrap'),
  messages: (opts: { limit?: number; before?: number; since?: number } = {}) => { const params = new URLSearchParams(); if (opts.limit) params.set('limit', String(opts.limit)); if (opts.before !== undefined) params.set('before', String(opts.before)); if (opts.since !== undefined) params.set('since', String(opts.since)); return request<{ messages: ChatMessage[]; hasMore: boolean; nextSince?: number; lastEventSeq: number; lastMessageSeq: number; oldestSeq: number | null }>(`/api/messages?${params.toString()}`); },
  send: (payload: { clientMsgId: string; content: unknown[]; directives?: Record<string, boolean>; replyTo?: string }) => request<{ message: ChatMessage; duplicate: boolean; replyPending: boolean }>('/api/messages', { method: 'POST', body: JSON.stringify(payload) }),
  withdraw: (id: string) => request<{ message: ChatMessage }>(`/api/messages/${encodeURIComponent(id)}/withdraw`, { method: 'POST' }),
  upload: async (files: Array<{ file: File | Blob; field: 'image' | 'file'; name?: string }>, options: { signal?: AbortSignal } = {}) => { const form = new FormData(); for (const f of files) form.append(f.field, f.file, f.name ?? (f.file instanceof File ? f.file.name : 'upload')); return request<{ media: MediaRef[]; failed: Array<{ filename: string; error: string; code?: string }> }>('/api/media', { method: 'POST', body: form, signal: options.signal }); },
  capabilities: () => request<{ capabilities: Record<string, { configured: boolean; ok: boolean; detail?: string }>; stickers: { available: number; total: number } }>('/api/capabilities'),
  life: () => request<{ activity: string; kind: string; mood: string; startedAt: string; endsAt: string; recent: Array<{ activity: string; startedAt: string; endedAt: string }> }>('/api/life'),
  events: (since: number) => request<{ events: Array<Record<string, unknown>>; lastEventSeq: number }>(`/api/events?since=${since}`)
};
/** @deprecated Render protected media through useAuthenticatedMedia instead. */
export function mediaUrl(url: string): string { return credentialFreeMediaPath(url); }
