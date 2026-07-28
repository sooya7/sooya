import type { FastifyReply } from 'fastify';
import type { SooyaApp } from '../app.js';
import { requireChatToken } from './auth.js';
import type { StreamEvent } from '../core/types.js';

const HEARTBEAT_MS = 15_000;

/**
 * SSE stream with durable replay.
 *
 * A client reconnects with `Last-Event-ID` (or `?lastEventId=`), and every
 * event persisted after that seq is replayed before live events resume, so a
 * reply written while the socket was down is still delivered without a refresh.
 */
export function registerStreamRoutes(app: SooyaApp): void {
  const { server, services } = app;
  const auth = requireChatToken(app);

  server.get('/api/stream', { preHandler: auth }, async (req, reply) => {
    const query = req.query as { lastEventId?: string };
    const headerId = req.headers['last-event-id'];
    const rawLast = (typeof headerId === 'string' ? headerId : undefined) ?? query.lastEventId;
    const lastSeq = parseSeq(rawLast);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    reply.raw.write(': sooya stream open\n\n');

    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe = () => undefined;
    let sentSeq = lastSeq ?? 0;
    let replaying = true;
    const pendingLive: StreamEvent[] = [];

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    };

    const write = (event: StreamEvent) => {
      if (closed || event.seq <= sentSeq) return;
      try {
        reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(serialize(event))}\n\n`);
        sentSeq = event.seq;
      } catch {
        cleanup();
      }
    };

    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    reply.raw.on('error', cleanup);

    // Subscribe before reading the durable log. Any event published while replay
    // is being queried is buffered, then de-duplicated by seq after replay. This
    // closes the old replay -> subscribe window where one event could disappear.
    unsubscribe = services.bus.subscribe((event) => {
      if (replaying) pendingLive.push(event);
      else write(event);
    });

    // 1. Replay anything missed.
    let replayed = 0;
    if (lastSeq !== null) {
      for (const event of services.bus.replay(lastSeq, 1000)) {
        write(event);
        replayed++;
      }
    }

    // 2. Flush events that arrived during replay. Sorting is defensive: the bus
    // is synchronous today, but ordering by durable seq keeps this correct if its
    // implementation changes later.
    replaying = false;
    pendingLive.sort((a, b) => a.seq - b.seq);
    for (const event of pendingLive) write(event);
    pendingLive.length = 0;

    // 3. Tell the client where it stands so it can reconcile via REST if the
    //    event log had already been pruned past its position.
    const currentSeq = services.bus.lastSeq();
    const oldestSeq = services.bus.oldestSeq();
    // A gap exists when events were issued after the client's position but are
    // no longer retained (pruned/cleared). The client must then reconcile via
    // GET /api/messages?since=... instead of trusting the replay.
    const gapPossible =
      lastSeq !== null && currentSeq > lastSeq && (oldestSeq === 0 || oldestSeq > lastSeq + 1);
    reply.raw.write(
      `event: stream.ready\ndata: ${JSON.stringify({
        lastEventSeq: currentSeq,
        oldestEventSeq: oldestSeq,
        replayed,
        gapPossible,
        lastMessageSeq: app.repos.messages.maxSeq()
      })}\n\n`
    );

    // 4. Keep the live connection healthy.
    heartbeat = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(`: ping ${Date.now()}\n\n`);
      } catch {
        cleanup();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    // Keep the handler alive; Fastify must not send its own response.
    await new Promise<void>((resolve) => {
      req.raw.on('close', resolve);
      reply.raw.on('close', resolve);
    });
  });

  /** Polling fallback for environments where SSE is blocked. */
  server.get('/api/events', { preHandler: auth }, async (req) => {
    const q = req.query as { since?: string; limit?: string };
    const since = parseSeq(q.since) ?? 0;
    const limit = Math.min(Number(q.limit ?? 200) || 200, 500);
    const events = services.bus.replay(since, limit).map(serialize);
    return { events, lastEventSeq: services.bus.lastSeq() };
  });
}

function serialize(event: StreamEvent): Record<string, unknown> {
  return { id: event.id, seq: event.seq, type: event.type, createdAt: event.createdAt, ...event.payload };
}

function parseSeq(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

export type { FastifyReply };
