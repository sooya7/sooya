import type { FastifyInstance } from 'fastify';

interface Rule {
  limit: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * How much slack the shared per-prefix ceiling gets over the per-client limit.
 * High enough that one client can never reach it alone (so a single source
 * cannot lock anyone else out), low enough to still catch a genuine runaway
 * loop fanning out across many sources.
 */
const SHARED_CEILING_MULTIPLIER = 8;

/** Cap on tracked client buckets, so rotating source addresses cannot grow the map without bound. */
const MAX_CLIENT_BUCKETS = 4096;

/**
 * §38 app-level light rate limit — a safety net behind the public reverse
 * proxy, not a policy engine. Per-prefix fixed windows, generous limits:
 * normal single-user chat traffic must never trip these; only runaway loops
 * and credential-stuffing-style bursts do. 429 carries Retry-After.
 *
 * Two buckets per prefix, and the split matters:
 *
 * 1. **Per client.** This hook necessarily runs at `onRequest`, i.e. before
 *    any auth guard. The previous version keyed the bucket on the URL prefix
 *    alone, so every caller shared one counter — which turned the rate limiter
 *    into a remotely triggerable lockout: an unauthenticated flood at
 *    `/api/admin/*` exhausted the same 240/min the operator needed, and the
 *    owner got 429s from their own console. Keying per client contains a noisy
 *    source to its own budget.
 *
 * 2. **Shared ceiling.** Retained as the original blunt safety net for a
 *    runaway loop, but at `SHARED_CEILING_MULTIPLIER×` the per-client limit so
 *    a single source cannot reach it on its own.
 *
 * Client identity comes from `req.ip`, which honours Fastify's `trustProxy`
 * setting — see TRUST_PROXY in config/env.ts. Behind the documented Nginx
 * front end that is the real client; with `trustProxy` off it is the socket
 * peer. Never trust `X-Forwarded-For` unconditionally, or this key becomes
 * attacker-chosen and the per-client split buys nothing.
 */
export function lightRateLimit(server: FastifyInstance, rules: Record<string, Rule>): void {
  const clientBuckets = new Map<string, Bucket>();
  const sharedBuckets = new Map<string, Bucket>();

  const keyFor = (url: string): { prefix: string; rule: Rule } | null => {
    for (const [prefix, rule] of Object.entries(rules)) {
      if (url === prefix || url.startsWith(`${prefix}/`)) return { prefix, rule };
    }
    return null;
  };

  /** Drop windows that have already expired; keeps both maps proportional to live traffic. */
  const prune = (buckets: Map<string, Bucket>, now: number): void => {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  };

  /** Returns the retry-after seconds when the rule is exceeded, else null. */
  const consume = (buckets: Map<string, Bucket>, key: string, rule: Rule, now: number): number | null => {
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      return null;
    }
    bucket.count++;
    if (bucket.count > rule.limit) return Math.ceil((bucket.resetAt - now) / 1000);
    return null;
  };

  server.addHook('onRequest', async (req, reply) => {
    const match = keyFor(req.url);
    if (!match) return;
    const now = Date.now();

    if (clientBuckets.size >= MAX_CLIENT_BUCKETS) {
      prune(clientBuckets, now);
      // Still full after pruning: every tracked window is live, which is itself
      // the abuse signal. Reset rather than grow — the shared ceiling below
      // remains in force for this request either way.
      if (clientBuckets.size >= MAX_CLIENT_BUCKETS) clientBuckets.clear();
    }

    const client = req.ip || 'unknown';
    const retryAfterSec =
      consume(clientBuckets, `${match.prefix}|${client}`, match.rule, now)
      ?? consume(sharedBuckets, match.prefix, {
        limit: match.rule.limit * SHARED_CEILING_MULTIPLIER,
        windowMs: match.rule.windowMs
      }, now);

    if (retryAfterSec !== null) {
      return reply
        .code(429)
        .header('retry-after', String(Math.max(1, retryAfterSec)))
        .send({ error: 'rate_limited', retryAfterSeconds: retryAfterSec });
    }
  });
}
