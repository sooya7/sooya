import { EventEmitter } from 'node:events';
import type { EventRepo } from '../db/repos/misc.repo.js';
import type { StreamEvent, StreamEventType } from '../core/types.js';

/**
 * Durable event bus. Every event is persisted with a monotonic seq *before*
 * being fanned out, so a client that reconnects with `Last-Event-ID` can
 * replay anything it missed. This is what guarantees "a reply written to the
 * database can never be invisible until refresh".
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly repo: EventRepo) {
    this.emitter.setMaxListeners(64);
  }

  publish(type: StreamEventType, payload: Record<string, unknown> = {}): StreamEvent {
    const event = this.repo.append(type, payload);
    this.emitter.emit('event', event);
    return event;
  }

  subscribe(listener: (e: StreamEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** Events after `seq`, used for catch-up on reconnect. */
  replay(seq: number, limit = 500): StreamEvent[] {
    return this.repo.since(seq, limit);
  }

  lastSeq(): number {
    return this.repo.lastSeq();
  }

  /** Oldest replayable event seq; 0 when the log is empty. */
  oldestSeq(): number {
    return this.repo.oldestSeq();
  }

  prune(keep = 2000): number {
    return this.repo.prune(keep);
  }

  subscriberCount(): number {
    return this.emitter.listenerCount('event');
  }
}
