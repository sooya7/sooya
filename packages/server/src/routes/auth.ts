import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SooyaApp } from '../app.js';
import { ensureFullBackupRoutes } from './full-backup.js';

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still perform a comparison to keep timing roughly constant.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function extractToken(req: FastifyRequest, headerName: string): string | null {
  const header = req.headers[headerName];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

/**
 * Admin API guard. Unlike the chat token this one is fail-closed: if
 * ADMIN_API_TOKEN is not configured, every admin endpoint is disabled —
 * reads included, not just writes.
 */
export function requireAdminToken(app: SooyaApp) {
  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const expected = app.env.ADMIN_API_TOKEN;
    if (!expected) {
      return reply.code(503).send({
        error: 'admin_disabled',
        message: 'ADMIN_API_TOKEN is not configured; admin API is disabled'
      });
    }
    const provided = extractToken(req, 'x-admin-token');
    if (!provided || !timingSafeEqual(provided, expected)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'valid ADMIN_API_TOKEN required' });
    }
  };
  ensureFullBackupRoutes(app, guard);
  return guard;
}
