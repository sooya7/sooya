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
 * §38 app-level light rate limit — a safety net behind the public reverse
 * proxy, not a policy engine. Per-prefix fixed windows, generous limits:
 * normal single-user chat traffic must never trip these; only runaway loops
 * and credential-stuffing-style bursts do. 429 carries Retry-After.
 */
export function lightRateLimit(server: FastifyInstance, rules: Record<string, Rule>): void {
  const buckets = new Map<string, Bucket>();

  const keyFor = (url: string): { prefix: string; rule: Rule } | null => {
    for (const [prefix, rule] of Object.entries(rules)) {
      if (url === prefix || url.startsWith(`${prefix}/`)) return { prefix, rule };
    }
    return null;
  };

  server.addHook('onRequest', async (req, reply) => {
    const match = keyFor(req.url);
    if (!match) return;
    // Single-user deployment: the caller identity is the deployment itself.
    const key = match.prefix;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + match.rule.windowMs });
      return;
    }
    bucket.count++;
    if (bucket.count > match.rule.limit) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      return reply
        .code(429)
        .header('retry-after', String(Math.max(1, retryAfterSec)))
        .send({ error: 'rate_limited', retryAfterSeconds: retryAfterSec });
    }
  });
}
