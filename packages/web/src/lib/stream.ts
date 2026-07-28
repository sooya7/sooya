import { getToken } from './api.js';

export interface StreamHandlers {
  onEvent: (type: string, data: Record<string, any>) => void;
  onStateChange: (state: 'connecting' | 'online' | 'offline' | 'unauthorized') => void;
  /** Called when replay could not cover the gap; the app must re-sync via REST. */
  onGap: (lastMessageSeq: number) => void;
}

/**
 * Durable SSE client.
 *
 * - reconnects with exponential backoff + jitter
 * - resumes from the last received event id so nothing is missed
 * - asks the app to reconcile through REST when the server reports a gap
 */
export class ChatStream {
  private source: EventSource | null = null;
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
    'message.updated',
    'memory.updated',
    'system.notice',
    'stream.ready'
  ];

  constructor(private readonly handlers: StreamHandlers) {}

  setLastEventId(seq: number): void {
    if (seq > this.lastEventId) this.lastEventId = seq;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    window.addEventListener('online', this.handleOnline);
    document.addEventListener('visibilitychange', this.handleVisibility);
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.handleOnline);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    if (this.timer) window.clearTimeout(this.timer);
    this.source?.close();
    this.source = null;
  }

  private handleOnline = () => {
    if (!this.stopped && this.source === null) this.connect();
  };

  private handleVisibility = () => {
    // Mobile browsers silently kill background EventSources.
    if (document.visibilityState === 'visible' && !this.stopped && this.source === null) this.connect();
  };

  private connect(): void {
    if (this.stopped) return;
    this.handlers.onStateChange('connecting');
    const params = new URLSearchParams();
    if (this.lastEventId > 0) params.set('lastEventId', String(this.lastEventId));
    const token = getToken();
    if (token) params.set('token', token);
    const url = `/api/stream${params.toString() ? `?${params.toString()}` : ''}`;

    let source: EventSource;
    try {
      source = new EventSource(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.source = source;

    source.onopen = () => {
      this.retry = 0;
      this.handlers.onStateChange('online');
    };

    source.onerror = () => {
      source.close();
      if (this.source === source) this.source = null;
      this.handlers.onStateChange('offline');
      this.scheduleReconnect();
    };

    const handle = (type: string) => (evt: MessageEvent<string>) => {
      if (evt.lastEventId) {
        const seq = Number(evt.lastEventId);
        if (Number.isFinite(seq)) this.setLastEventId(seq);
      }
      let data: Record<string, any> = {};
      try {
        data = JSON.parse(evt.data) as Record<string, any>;
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
    };

    for (const type of this.types) source.addEventListener(type, handle(type) as EventListener);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.timer) window.clearTimeout(this.timer);
    const delay = Math.min(1000 * 2 ** this.retry, 15_000) + Math.random() * 500;
    this.retry = Math.min(this.retry + 1, 5);
    this.timer = window.setTimeout(() => this.connect(), delay);
  }
}
