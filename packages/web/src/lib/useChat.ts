import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import { ChatStream } from './stream.js';
import { fetchAllMessagePages, replaceFailedMessage } from './messageSync.js';
import type { ActivityState, ChatMessage, ConnectionState, LifeState, PersonaInfo, StickerInfo } from './types.js';

const PAGE_SIZE = 30;
/** Matches the server's `?since=` cap; catch-up walks pages of this size. */
const CATCHUP_PAGE_SIZE = 100;
export type QuotedMessageState = { status: 'loading' | 'ready' | 'missing' | 'error'; message?: ChatMessage };
function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return existing;
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const message of incoming) {
    if (message.clientMsgId) for (const [id, old] of byId) if (old.pendingLocal && old.clientMsgId === message.clientMsgId) byId.delete(id);
    byId.set(message.id, { ...byId.get(message.id), ...message });
  }
  return [...byId.values()].sort((a, b) => a.seq !== b.seq ? a.seq - b.seq : a.createdAt.localeCompare(b.createdAt));
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [persona, setPersona] = useState<PersonaInfo | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [activity, setActivity] = useState<ActivityState>({ thinking: false, label: null });
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [life, setLife] = useState<LifeState | null>(null);
  const [stickers, setStickers] = useState<StickerInfo[]>([]);
  const [quotedStates, setQuotedStates] = useState<Record<string, QuotedMessageState>>({});
  const streamRef = useRef<ChatStream | null>(null);
  const maxSeqRef = useRef(0);
  const draftRef = useRef(new Map<string, string>());
  const quotedStatesRef = useRef(new Map<string, QuotedMessageState>());
  const quotedRequestsRef = useRef(new Map<string, Promise<ChatMessage | null>>());
  const reloadRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const trackSeq = useCallback((list: ChatMessage[]) => { for (const m of list) if (m.seq > maxSeqRef.current) maxSeqRef.current = m.seq; }, []);
  const applyMessages = useCallback((incoming: ChatMessage[]) => { trackSeq(incoming); setMessages((prev) => mergeMessages(prev, incoming)); }, [trackSeq]);

  const resync = useCallback(async () => {
    try {
      const since = maxSeqRef.current;
      if (since > 0) {
        // The server caps each catch-up page, so walk the cursor until it is drained (H6).
        const caught = await fetchAllMessagePages(since, async (cursor) => {
          const page = await api.messages({ since: cursor, limit: CATCHUP_PAGE_SIZE });
          return { messages: page.messages, hasMore: page.hasMore, nextSince: page.nextSince };
        });
        applyMessages(caught);
      } else {
        const first = await api.messages({ limit: PAGE_SIZE });
        applyMessages(first.messages);
        setHasMore(first.hasMore);
      }
      setError(null);
    }
    catch (err) { if (err instanceof ApiError && err.status === 401) setConnection('unauthorized'); else setError((err as Error).message); }
  }, [applyMessages]);

  const refreshLife = useCallback(async () => {
    // Never surfaces an error: what she is doing is decoration next to the
    // conversation, and must not be able to break the chat.
    try { setLife(await api.life()); } catch { /* ignore */ }
  }, []);

  const startStream = useCallback((lastEventSeq = maxSeqRef.current) => {
    if (streamRef.current) return;
    const stream = new ChatStream({
      onStateChange: setConnection,
      onGap: () => void resync(),
      onEvent: (type, data) => {
        switch (type) {
          case 'message.received':
          case 'message.updated': if (data.message) applyMessages([data.message as ChatMessage]); break;
          case 'media.updated': {
            const mediaId = String(data.mediaId ?? '');
            const textStatus = data.textStatus;
            if (mediaId && (textStatus === 'pending' || textStatus === 'ready' || textStatus === 'failed' || textStatus === 'unsupported')) {
              setMessages((previous) => previous.map((message) => ({ ...message, content: message.content.map((part) => part.media?.id === mediaId ? { ...part, media: { ...part.media, textStatus } } : part) })));
            }
            break;
          }
          case 'persona.updated': if (data.persona) setPersona((old) => ({ ...(old ?? { name: 'SOOYA', avatar: '/avatars/sooya.svg', userAvatar: '/avatars/user.svg', tagline: '' }), ...(data.persona as PersonaInfo) })); break;
          case 'reply.queued': setActivity({ thinking: true, label: `正在看你刚发的 ${Number(data.count ?? 1)} 条消息` }); break;
          case 'reply.thinking': setActivity({ thinking: true, label: '正在思考' }); break;
          case 'reply.text.delta': { const id = String(data.messageId ?? ''); const text = String(data.text ?? ''); setActivity({ thinking: true, label: '正在输入' }); if (id) { draftRef.current.set(id, text); setMessages((prev) => applyDraft(prev, id, text)); } break; }
          case 'reply.sticker.selecting': setActivity({ thinking: true, label: '正在挑表情' }); break;
          case 'reply.image.generating': setActivity({ thinking: true, label: '正在生成图片' }); break;
          case 'reply.audio.generating': setActivity({ thinking: true, label: '正在生成语音' }); break;
          case 'reply.text.done':
          case 'reply.content.done': setActivity({ thinking: true, label: '正在整理' }); break;
          case 'reply.completed': { setActivity({ thinking: false, label: null }); const msg = data.message as ChatMessage | undefined; if (msg) { draftRef.current.delete(msg.id); applyMessages([msg]); } else void resync(); break; }
          case 'reply.failed': { setActivity({ thinking: false, label: null }); const msg = data.message as ChatMessage | undefined; if (msg) applyMessages([msg]); setError(typeof data.error === 'string' ? data.error : '回复失败'); break; }
          case 'life.updated': void refreshLife(); break;
          case 'system.notice': if (data.action === 'reload') void reloadRef.current(); else void resync(); break;
          default: break;
        }
      }
    });
    stream.setLastEventId(lastEventSeq);
    stream.start();
    streamRef.current = stream;
  }, [applyMessages, refreshLife, resync]);

  const reload = useCallback(async () => {
    setReady(false); setConnection('connecting'); setError(null);
    try {
      maxSeqRef.current = 0; draftRef.current.clear(); quotedStatesRef.current.clear(); quotedRequestsRef.current.clear(); setQuotedStates({});
      const boot = await api.bootstrap();
      setPersona(boot.conversation.persona); trackSeq(boot.messages.messages); setMessages(boot.messages.messages); setHasMore(boot.messages.hasMore); setLife(boot.life); setStickers(boot.stickers); streamRef.current?.setLastEventId(boot.messages.lastEventSeq); setActivity({ thinking: false, label: null }); setError(null); setReady(true);
      startStream(boot.messages.lastEventSeq);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setConnection('unauthorized'); else { setConnection('offline'); setError((err as Error).message); }
      setReady(true);
    }
  }, [startStream, trackSeq]);
  reloadRef.current = reload;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const boot = await api.bootstrap();
        if (cancelled) return;
        setPersona(boot.conversation.persona); applyMessages(boot.messages.messages); setHasMore(boot.messages.hasMore); setLife(boot.life); setStickers(boot.stickers); setReady(true);
        startStream(boot.messages.lastEventSeq);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setConnection('unauthorized'); else { setConnection('offline'); setError((err as Error).message); }
        setReady(true);
      }
    })();
    return () => { cancelled = true; streamRef.current?.stop(); streamRef.current = null; };
  }, [applyMessages, refreshLife, reload, resync, startStream]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore) return;
    const oldest = messages.find((m) => !m.pendingLocal); if (!oldest) return;
    setLoadingOlder(true);
    try { const result = await api.messages({ limit: PAGE_SIZE, before: oldest.seq }); setMessages((prev) => mergeMessages(prev, result.messages)); setHasMore(result.hasMore); }
    catch (err) { setError((err as Error).message); } finally { setLoadingOlder(false); }
  }, [hasMore, loadingOlder, messages]);

  const ensureQuotedMessage = useCallback((id: string): Promise<ChatMessage | null> => {
    const known = quotedStatesRef.current.get(id);
    if (known?.status === 'ready') return Promise.resolve(known.message ?? null);
    if (known?.status === 'missing') return Promise.resolve(null);
    const active = quotedRequestsRef.current.get(id);
    if (active) return active;
    const request = (async () => {
      quotedStatesRef.current.set(id, { status: 'loading' });
      setQuotedStates((previous) => ({ ...previous, [id]: { status: 'loading' } }));
      try {
        const context = await api.messageContext(id, { before: 20, after: 20 });
        applyMessages(context.messages);
        const ready = { status: 'ready' as const, message: context.target };
        quotedStatesRef.current.set(id, ready);
        setQuotedStates((previous) => ({ ...previous, [id]: ready }));
        return context.target;
      } catch (err) {
        const status = err instanceof ApiError && err.status === 404 ? 'missing' as const : 'error' as const;
        quotedStatesRef.current.set(id, { status });
        setQuotedStates((previous) => ({ ...previous, [id]: { status } }));
        if (status === 'error') setError((err as Error).message);
        return null;
      } finally {
        quotedRequestsRef.current.delete(id);
      }
    })();
    quotedRequestsRef.current.set(id, request);
    return request;
  }, [applyMessages]);

  const send = useCallback(async (content: Array<Record<string, unknown>>, optimisticParts?: ChatMessage['content'], replyTo?: string) => {
    if (content.length === 0) return undefined;
    const clientMsgId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const optimistic: ChatMessage = { id: `local_${clientMsgId}`, conversationId: 'main', role: 'user', createdAt: now, updatedAt: now, seq: Number.MAX_SAFE_INTEGER - 1, status: 'pending', clientMsgId, replyTo, content: optimisticParts ?? content.map((c, i) => ({ id: `localpart_${i}`, type: c.type as ChatMessage['content'][number]['type'], text: (c.text as string) ?? null, mediaId: (c.mediaId as string) ?? null, status: 'pending' })), pendingLocal: true };
    setMessages((prev) => [...prev, optimistic]); setError(null);
    try { const result = await api.send({ clientMsgId, content, replyTo }); applyMessages([result.message]); setMessages((prev) => prev.filter((m) => m.id !== optimistic.id)); return result; }
    catch (err) { setMessages((prev) => prev.map((m) => m.id === optimistic.id ? { ...m, status: 'failed', error: (err as Error).message } : m)); if (err instanceof ApiError && err.status === 401) setConnection('unauthorized'); setError((err as Error).message); throw err; }
  }, [applyMessages]);

  const retryFailed = useCallback(async (message: ChatMessage) => {
    if (message.status !== 'failed' || !isRetryableFailedMessage(message)) return;
    const content = messageToContent(message);
    if (!message.clientMsgId) return await send(content, undefined, message.replyTo ?? undefined);
    const clientMsgId = message.clientMsgId;
    setMessages((prev) => prev.map((m) => m.id === message.id ? { ...m, status: 'pending', error: null, pendingLocal: true } : m));
    setError(null);
    try {
      const result = await api.send({ clientMsgId, content, replyTo: message.replyTo ?? undefined });
      trackSeq([result.message]);
      setMessages((prev) => replaceFailedMessage(prev, clientMsgId, { ...result.message, pendingLocal: false }));
      return result;
    } catch (err) {
      setMessages((prev) => prev.map((m) => m.id === message.id ? { ...m, status: 'failed', error: (err as Error).message, pendingLocal: true } : m));
      if (err instanceof ApiError && err.status === 401) setConnection('unauthorized');
      setError((err as Error).message);
      throw err;
    }
  }, [send, trackSeq]);

  const sendAgain = useCallback((message: ChatMessage) => {
    if (message.status === 'failed' || message.pendingLocal || !isReplayableUserMessage(message)) return Promise.resolve(undefined);
    return send(messageToContent(message), optimisticPartsFor(message), message.replyTo ?? undefined);
  }, [send]);

  const withdraw = useCallback(async (message: ChatMessage) => { const result = await api.withdraw(message.id); applyMessages([result.message]); return result; }, [applyMessages]);

  useEffect(() => { const focus = () => { if (document.visibilityState === 'visible') void resync(); }; document.addEventListener('visibilitychange', focus); window.addEventListener('focus', focus); return () => { document.removeEventListener('visibilitychange', focus); window.removeEventListener('focus', focus); }; }, [resync]);

  return { messages, persona, connection, activity, life, stickers, quotedStates, hasMore, loadingOlder, error, ready, send, retryFailed, sendAgain, withdraw, loadOlder, ensureQuotedMessage, resync, reload, clearError: () => setError(null) };
}

export function isReplayableUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user' || message.content.some((part) => part.type === 'audio')) return false;
  return messageToContent(message).length > 0;
}

export function isRetryableFailedMessage(message: ChatMessage): boolean {
  return message.status === 'failed' && Boolean(message.clientMsgId) && isReplayableUserMessage(message);
}

function messageToContent(message: ChatMessage): Array<Record<string, unknown>> {
  return message.content
    .filter((part) => part.type !== 'system' && part.type !== 'audio')
    .map((part) => part.type === 'text' ? { type: 'text', text: part.text ?? '' } : { type: part.type, mediaId: part.mediaId })
    .filter((part) => part.type === 'text' ? Boolean(part.text) : Boolean(part.mediaId));
}

function optimisticPartsFor(message: ChatMessage): ChatMessage['content'] {
  return message.content
    .filter((part) => part.type !== 'system' && part.type !== 'audio')
    .map((part, index) => ({ ...part, id: `localpart_${index}`, status: 'pending' as const }));
}

function applyDraft(messages: ChatMessage[], messageId: string, text: string): ChatMessage[] {
  const existing = messages.find((m) => m.id === messageId);
  if (existing) { const content = existing.content.some((p) => p.type === 'text') ? existing.content.map((p) => p.type === 'text' ? { ...p, text } : p) : [{ id: 'draft', type: 'text' as const, text, status: 'pending' as const }, ...existing.content]; return messages.map((m) => m.id === messageId ? { ...m, content, status: 'sending' as const } : m); }
  return [...messages, { id: messageId, conversationId: 'main', role: 'assistant', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), seq: Number.MAX_SAFE_INTEGER, status: 'sending', content: [{ id: 'draft', type: 'text', text, status: 'pending' }] }];
}
