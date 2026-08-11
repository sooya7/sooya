import type { ChatMessage, LifeState, MediaRef, PersonaInfo, StickerInfo, WorldPresence } from './types.js';
import { clearMediaCache, credentialFreeMediaPath } from './authenticatedMedia.js';

const TOKEN_KEY = 'sooya.token';
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string): void {
  const changed = getToken() !== token;
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
  if (changed) clearMediaCache('user');
}

export function clearToken(): void {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  clearMediaCache('user');
}
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
export interface MessageContext { target: ChatMessage; messages: ChatMessage[]; hasOlder: boolean; hasNewer: boolean; }
export interface MessageSearchHit { message: ChatMessage; snippet: string; matchedPartId: string | null; }
export interface Moment {
  id: string;
  text: string;
  activity: string;
  image: { id: string; url: string; kind: 'pov' | 'selfie' | null } | null;
  location: { id: string | null; name: string | null; city: string | null } | null;
  weather: { condition: string; temperatureC: number | null } | null;
  liked: boolean;
  createdAt: string;
}
/** 首屏一次性载荷：会话 + 最新一页消息 + 贴纸 + 她正在做什么。 */
export interface BootstrapInfo { conversation: ConversationInfo; messages: { messages: ChatMessage[]; hasMore: boolean; lastEventSeq: number; lastMessageSeq: number; oldestSeq: number | null }; stickers: StickerInfo[]; life: LifeState; presence: WorldPresence; }
export interface VisibleThought {
  id: string;
  messageId: string;
  batchId: string;
  revision: number;
  kind: 'inner_monologue' | 'decision_summary';
  text: string;
  visibility: 'user' | 'admin';
  status: 'generating' | 'completed' | 'cancelled' | 'failed';
  createdAt: string;
}

export const api = {
  bootstrap: () => request<BootstrapInfo>('/api/bootstrap'),
  conversation: () => request<ConversationInfo>('/api/conversation'),
  moments: (limit = 50) => request<{ moments: Moment[]; hasMore: boolean }>(`/api/moments?limit=${Math.max(1, Math.min(100, limit))}`),
  likeMoment: (id: string, liked: boolean) => request<{ moment: Moment }>(`/api/moments/${encodeURIComponent(id)}/like`, { method: 'PATCH', body: JSON.stringify({ liked }) }),
  messages: (opts: { limit?: number; before?: number; since?: number } = {}) => { const params = new URLSearchParams(); if (opts.limit) params.set('limit', String(opts.limit)); if (opts.before !== undefined) params.set('before', String(opts.before)); if (opts.since !== undefined) params.set('since', String(opts.since)); return request<{ messages: ChatMessage[]; hasMore: boolean; nextSince?: number; lastEventSeq: number; lastMessageSeq: number; oldestSeq: number | null }>(`/api/messages?${params.toString()}`); },
  messageSearch: (q: string, opts: { limit?: number; cursor?: string | null } = {}) => { const params = new URLSearchParams({ q }); if (opts.limit) params.set('limit', String(opts.limit)); if (opts.cursor) params.set('cursor', opts.cursor); return request<{ hits: MessageSearchHit[]; nextCursor: string | null }>(`/api/messages/search?${params.toString()}`); },
  messagesByDate: (date: string, timeZone: string, limit = 200) => { const params = new URLSearchParams({ date, timeZone, limit: String(limit) }); return request<{ date: string; timeZone: string; messages: ChatMessage[]; hasMore: boolean }>(`/api/messages/by-date?${params.toString()}`); },
  messageContext: (id: string, opts: { before?: number; after?: number } = {}) => { const params = new URLSearchParams(); if (opts.before !== undefined) params.set('before', String(opts.before)); if (opts.after !== undefined) params.set('after', String(opts.after)); return request<MessageContext>(`/api/messages/${encodeURIComponent(id)}/context?${params.toString()}`); },
  stickerSearch: (opts: { scope?: 'recent' | 'favorite' | 'all'; q?: string; limit?: number; cursor?: string | null } = {}) => {
    const params = new URLSearchParams({ scope: opts.scope ?? 'all' });
    if (opts.q?.trim()) params.set('q', opts.q.trim());
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    return request<{ stickers: StickerInfo[]; total: number; nextCursor: string | null }>(`/api/stickers?${params.toString()}`);
  },
  stickerPreference: (id: string, favorite: boolean) => request<{ sticker: StickerInfo }>(`/api/stickers/${encodeURIComponent(id)}/preferences`, { method: 'PATCH', body: JSON.stringify({ favorite }) }),
  mediaMeta: (id: string) => request<{ media: MediaRef; text: { status: string; value?: string | null; metadata?: unknown; error?: string | null } | null; exists: boolean }>(`/api/media/${encodeURIComponent(id)}/meta`),
  send: (payload: { clientMsgId: string; content: unknown[]; directives?: Record<string, boolean>; replyTo?: string }) => request<{ message: ChatMessage; duplicate: boolean; replyPending: boolean }>('/api/messages', { method: 'POST', body: JSON.stringify(payload) }),
  withdraw: (id: string) => request<{ message: ChatMessage }>(`/api/messages/${encodeURIComponent(id)}/withdraw`, { method: 'POST' }),
  retryBatch: (id: string) => request<{ batchId: string; revision: number; status: string }>(`/api/reply-batches/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  upload: async (files: Array<{ file: File | Blob; field: 'image' | 'file'; name?: string }>, options: { signal?: AbortSignal } = {}) => { const form = new FormData(); for (const f of files) form.append(f.field, f.file, f.name ?? (f.file instanceof File ? f.file.name : 'upload')); return request<{ media: MediaRef[]; failed: Array<{ filename: string; error: string; code?: string }> }>('/api/media', { method: 'POST', body: form, signal: options.signal }); },
  capabilities: () => request<{ capabilities: Record<string, { configured: boolean; ok: boolean; detail?: string }>; stickers: { available: number; total: number } }>('/api/capabilities'),
  life: () => request<{ activity: string; kind: string; mood: string; startedAt: string; endsAt: string; recent: Array<{ activity: string; startedAt: string; endedAt: string }> }>('/api/life'),
  presence: () => request<WorldPresence>('/api/life/presence'),
  events: (since: number) => request<{ events: Array<Record<string, unknown>>; lastEventSeq: number }>(`/api/events?since=${since}`),
  /** User-visible inner thought for a message — chat token auth, may 404. */
  visibleThought: (messageId: string, signal?: AbortSignal) => request<{ thought: VisibleThought | null }>(`/api/thoughts/${encodeURIComponent(messageId)}`, { signal })
};
/** @deprecated Render protected media through useAuthenticatedMedia instead. */
export function mediaUrl(url: string): string { return credentialFreeMediaPath(url); }
