import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import { ChatStream } from './stream.js';
import type { ActivityState, ChatMessage, ConnectionState, PersonaInfo } from './types.js';

const PAGE_SIZE = 30;

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) {
    // A server message replaces the optimistic local copy with the same clientMsgId.
    if (m.clientMsgId) {
      for (const [id, prev] of byId) {
        if (prev.pendingLocal && prev.clientMsgId === m.clientMsgId) byId.delete(id);
      }
    }
    byId.set(m.id, { ...byId.get(m.id), ...m });
  }
  return [...byId.values()].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export interface ChatState {
  messages: ChatMessage[];
  persona: PersonaInfo | null;
  connection: ConnectionState;
  activity: ActivityState;
  hasMore: boolean;
  loadingOlder: boolean;
  error: string | null;
  ready: boolean;
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

  const streamRef = useRef<ChatStream | null>(null);
  const maxSeqRef = useRef(0);
  const draftRef = useRef<Map<string, string>>(new Map());

  const trackSeq = useCallback((list: ChatMessage[]) => {
    for (const m of list) if (m.seq > maxSeqRef.current) maxSeqRef.current = m.seq;
  }, []);

  const applyMessages = useCallback(
    (incoming: ChatMessage[]) => {
      trackSeq(incoming);
      setMessages((prev) => mergeMessages(prev, incoming));
    },
    [trackSeq]
  );

  /** Re-sync from the database — the source of truth for anything missed. */
  /**
   * Drop all local state and re-read the conversation from scratch.
   *
   * Used when the server reports that the database was replaced (a backup
   * restore): an incremental `since` fetch would leave messages on screen that
   * no longer exist, and the cached sequence numbers would point into the old
   * timeline.
   */
  const reload = useCallback(async () => {
    try {
      maxSeqRef.current = 0;
      draftRef.current.clear();
      const page = await api.messages({ limit: PAGE_SIZE });
      trackSeq(page.messages);
      setMessages(page.messages);
      setHasMore(page.hasMore);
      if (typeof page.lastEventSeq === 'number') streamRef.current?.setLastEventId(page.lastEventSeq);
      setActivity({ thinking: false, label: null });
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setConnection('unauthorized');
      else setError((err as Error).message);
    }
  }, [trackSeq]);

  const resync = useCallback(async () => {
    try {
      const since = maxSeqRef.current;
      const res = since > 0 ? await api.messages({ since, limit: 100 }) : await api.messages({ limit: PAGE_SIZE });
      applyMessages(res.messages);
      if (since === 0) setHasMore(res.hasMore);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setConnection('unauthorized');
      else setError((err as Error).message);
    }
  }, [applyMessages]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [conv, page] = await Promise.all([api.conversation(), api.messages({ limit: PAGE_SIZE })]);
        if (cancelled) return;
        setPersona(conv.persona);
        applyMessages(page.messages);
        setHasMore(page.hasMore);
        setReady(true);

        const stream = new ChatStream({
          onStateChange: (s) => setConnection(s),
          onGap: () => void resync(),
          onEvent: (type, data) => {
            switch (type) {
              case 'message.received':
                if (data.message) applyMessages([data.message as ChatMessage]);
                break;
              case 'reply.thinking':
                setActivity({ thinking: true, label: '正在思考' });
                break;
              case 'reply.text.delta': {
                setActivity({ thinking: true, label: '正在输入' });
                const id = String(data.messageId ?? '');
                const text = String(data.text ?? '');
                if (id) {
                  draftRef.current.set(id, text);
                  setMessages((prev) => applyDraft(prev, id, text));
                }
                break;
              }
              case 'reply.sticker.selecting':
                setActivity({ thinking: true, label: '正在挑表情' });
                break;
              case 'reply.image.generating':
                setActivity({ thinking: true, label: '正在生成图片' });
                break;
              case 'reply.audio.generating':
                setActivity({ thinking: true, label: '正在生成语音' });
                break;
              case 'reply.text.done':
              case 'reply.content.done':
                setActivity({ thinking: true, label: '正在整理' });
                break;
              case 'reply.media.saved':
                // Media landed; the completed event carries the final message.
                break;
              case 'reply.completed': {
                setActivity({ thinking: false, label: null });
                const msg = data.message as ChatMessage | undefined;
                if (msg) {
                  draftRef.current.delete(msg.id);
                  applyMessages([msg]);
                } else {
                  void resync();
                }
                break;
              }
              case 'reply.failed': {
                setActivity({ thinking: false, label: null });
                const msg = data.message as ChatMessage | undefined;
                if (msg) applyMessages([msg]);
                setError(typeof data.error === 'string' ? data.error : '回复失败');
                break;
              }
              case 'system.notice': {
                // A restore replaces the whole database, so an incremental
                // `since` fetch would keep stale messages on screen forever.
                if (data.action === 'reload') void reload();
                else void resync();
                break;
              }
              default:
                break;
            }
          }
        });
        // Seed the stream from the cursor that came WITH the message snapshot,
        // not from the separate /api/conversation call: those are two distinct
        // reads and an event landing between them would never be replayed.
        stream.setLastEventId(page.lastEventSeq ?? conv.lastEventSeq ?? 0);
        stream.start();
        streamRef.current = stream;
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setConnection('unauthorized');
        else {
          setConnection('offline');
          setError((err as Error).message);
        }
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.stop();
      streamRef.current = null;
    };
  }, [applyMessages, resync, reload]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore) return;
    const oldest = messages.find((m) => !m.pendingLocal);
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const res = await api.messages({ limit: PAGE_SIZE, before: oldest.seq });
      setMessages((prev) => mergeMessages(prev, res.messages));
      setHasMore(res.hasMore);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMore, loadingOlder, messages]);

  const send = useCallback(
    async (content: Array<Record<string, unknown>>, optimisticParts?: ChatMessage['content']) => {
      const clientMsgId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const optimistic: ChatMessage = {
        id: `local_${clientMsgId}`,
        conversationId: 'main',
        role: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        seq: Number.MAX_SAFE_INTEGER - 1,
        status: 'pending',
        clientMsgId,
        content:
          optimisticParts ??
          content.map((c, i) => ({
            id: `localpart_${i}`,
            type: c.type as ChatMessage['content'][number]['type'],
            text: (c.text as string) ?? null,
            mediaId: (c.mediaId as string) ?? null,
            status: 'pending'
          })),
        pendingLocal: true
      };
      setMessages((prev) => [...prev, optimistic]);
      setError(null);
      try {
        const res = await api.send({ clientMsgId, content });
        applyMessages([res.message]);
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        return res;
      } catch (err) {
        setMessages((prev) =>
          prev.map((m) => (m.id === optimistic.id ? { ...m, status: 'failed', error: (err as Error).message } : m))
        );
        if (err instanceof ApiError && err.status === 401) setConnection('unauthorized');
        setError((err as Error).message);
        throw err;
      }
    },
    [applyMessages]
  );

  // Safety net: whenever the tab regains focus, reconcile with the database.
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === 'visible') void resync();
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [resync]);

  return {
    messages,
    persona,
    connection,
    activity,
    hasMore,
    loadingOlder,
    error,
    ready,
    send,
    loadOlder,
    resync,
    reload,
    clearError: () => setError(null)
  };
}

/** Insert or update the streaming text bubble for an in-flight reply. */
function applyDraft(messages: ChatMessage[], messageId: string, text: string): ChatMessage[] {
  const existing = messages.find((m) => m.id === messageId);
  if (existing) {
    const content = existing.content.some((p) => p.type === 'text')
      ? existing.content.map((p) => (p.type === 'text' ? { ...p, text } : p))
      : [{ id: 'draft', type: 'text' as const, text, status: 'pending' as const }, ...existing.content];
    return messages.map((m) => (m.id === messageId ? { ...m, content, status: 'sending' as const } : m));
  }
  const draft: ChatMessage = {
    id: messageId,
    conversationId: 'main',
    role: 'assistant',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    seq: Number.MAX_SAFE_INTEGER,
    status: 'sending',
    content: [{ id: 'draft', type: 'text', text, status: 'pending' }]
  };
  return [...messages, draft];
}
