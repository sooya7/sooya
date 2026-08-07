import { getToken } from './api.js';

export interface StreamHandlers {
  onEvent: (type: string, data: Record<string, any>) => void;
  onStateChange: (state: 'connecting' | 'online' | 'offline' | 'unauthorized') => void;
  /** Called when replay could not cover the gap; the app must re-sync via REST. */
  onGap: (lastMessageSeq: number) => void;
}

export function buildStreamRequest(lastEventId: number, token: string | null): { url: string; init: RequestInit } {
  const params = new URLSearchParams();
  if (lastEventId > 0) params.set('lastEventId', String(lastEventId));
  return {
    url: `/api/stream${params.toString() ? `?${params.toString()}` : ''}`,
    init: {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: 'no-store'
    }
  };
}

/**
 * Durable SSE client.
 *
 * - reconnects with exponential backoff + jitter
 * - resumes from the last received event id so nothing is missed
 * - asks the app to reconcile through REST when the server reports a gap
 */
export class ChatStream {
  private controller: AbortController | null = null;
  private lastEventId = 0;
  private retry = 0;
  private timer: number | null = null;
  private stopped = false;
  private readonly types = [
    'message.received',
    'reply.thinking',
    'reply.text.delta',
    'reply.text.done',
    'reply.sticker.selecting',
    'reply.image.generating',
    'reply.audio.generating',
    'reply.content.done',
    'reply.media.saved',
    'reply.completed',
    'reply.failed',
    'reply.batch.collecting',
    'reply.batch.queued',
    'reply.generation.started',
    'reply.generation.interrupted',
    'reply.generation.retrying',
    'reply.publishing.started',
    'reply.publishing.partial',
    'reply.superseded',
    'voice.plan.created',
    'voice.script.completed',
    'voice.synthesis.started',
    'voice.synthesis.completed',
    'voice.synthesis.failed',
    'voice.generation.superseded',
    'voice.published',
    'voice.cancelled',
    'message.updated',
    'memory.updated',
    // Handled by useChat but missing here for the longest time — the list was
    // inherited from the EventSource era and silently dropped both frames
    // before dispatch, so admin persona edits and her activity changes never
    // reached the chat UI live.
    'persona.updated',
    'life.updated',
    'system.notice',
    'stream.ready'
  ];

  constructor(private readonly handlers: StreamHandlers) {}

  setLastEventId(seq: number): void {
    if (seq > this.lastEventId) this.lastEventId = seq;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
    window.addEventListener('online', this.handleOnline);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.handleOnline);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    if (this.timer) window.clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = null;
  }

  private handleOnline = () => {
    if (!this.stopped && this.controller === null) void this.connect();
  };

  private handleVisibility = () => {
    // Mobile browsers silently kill background EventSources.
    if (document.visibilityState === 'visible' && !this.stopped && this.controller === null) void this.connect();
  };

  private async connect(): Promise<void> {
    if (this.stopped) return;
    /*
     * One live connection at a time. An immediate reconnect (online event,
     * foreground tab) must retire a pending retry timer, or it fires later and
     * opens a second fetch whose completion overwrites `this.controller` — the
     * first connection then runs forever, unreachable even by stop().
     */
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.controller !== null) return;
    this.handlers.onStateChange('connecting');
    const token = getToken();
    const request = buildStreamRequest(this.lastEventId, token);
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await fetch(request.url, { ...request.init, signal: controller.signal });
      if (response.status === 401 || response.status === 403) {
        this.handlers.onStateChange('unauthorized');
        return;
      }
      if (!response.ok || !response.body) throw new Error(`stream failed (${response.status})`);
      this.retry = 0;
      this.handlers.onStateChange('online');
      await this.readEvents(response.body, controller.signal);
      if (!this.stopped && !controller.signal.aborted) throw new Error('stream ended');
    } catch {
      if (controller.signal.aborted || this.stopped) return;
      this.handlers.onStateChange('offline');
      this.scheduleReconnect();
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private dispatch(type: string, rawData: string, eventId: string): void {
    if (eventId) {
      const seq = Number(eventId);
      if (Number.isFinite(seq)) this.setLastEventId(seq);
    }
    let data: Record<string, any> = {};
    try {
      data = JSON.parse(rawData) as Record<string, any>;
    } catch {
      return;
    }
    if (typeof data.seq === 'number') this.setLastEventId(data.seq);
    if (type === 'stream.ready') {
      this.handlers.onStateChange('online');
      if (data.gapPossible) this.handlers.onGap(Number(data.lastMessageSeq ?? 0));
      if (typeof data.lastEventSeq === 'number') this.setLastEventId(data.lastEventSeq);
      return;
    }
    this.handlers.onEvent(type, data);
  }

  private async readEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let type = 'message';
          let id = '';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trimStart();
            else if (line.startsWith('id:')) id = line.slice(3).trimStart();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (data.length > 0 && this.types.includes(type)) this.dispatch(type, data.join('\n'), id);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.timer) window.clearTimeout(this.timer);
    const delay = Math.min(1000 * 2 ** this.retry, 15_000) + Math.random() * 500;
    this.retry = Math.min(this.retry + 1, 5);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
}
