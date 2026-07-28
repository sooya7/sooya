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
    const write = (event: StreamEvent) => {
      if (closed) return;
      try {
        reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(serialize(event))}\n\n`);
      } catch {
        closed = true;
      }
    };

    // 1. Replay anything missed.
    let replayed = 0;
    if (lastSeq !== null) {
      for (const e of services.bus.replay(lastSeq, 1000)) {
        write(e);
        replayed++;
      }
    }

    // 2. Tell the client where it stands so it can reconcile via REST if the
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

    // 3. Live events.
    const unsubscribe = services.bus.subscribe(write);
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(`: ping ${Date.now()}\n\n`);
      } catch {
        closed = true;
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        /* ignore */
      }
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    reply.raw.on('error', cleanup);

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
