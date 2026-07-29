import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SooyaApp } from '../app.js';

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
 * Chat API guard. When WEB_CHAT_TOKEN is unset the API is open (single-user
 * local deployment); when set, every /api route requires it.
 */
export function requireChatToken(app: SooyaApp) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const expected = app.env.WEB_CHAT_TOKEN;
    if (!expected) return;
    const provided = extractToken(req, 'x-sooya-token');
    if (!provided || !timingSafeEqual(provided, expected)) {
      // Admin token is also accepted so tooling needs only one secret.
      const admin = app.env.ADMIN_API_TOKEN;
      const adminProvided = extractToken(req, 'x-admin-token');
      if (admin && adminProvided && timingSafeEqual(adminProvided, admin)) return;
      // Returning the reply tells Fastify the request is already handled.
      return reply.code(401).send({ error: 'unauthorized', message: 'valid WEB_CHAT_TOKEN required' });
    }
  };
}

/**
 * Admin API guard. Unlike the chat token this one is fail-closed: if
 * ADMIN_API_TOKEN is not configured, every write endpoint is disabled.
 */
export function requireAdminToken(app: SooyaApp) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
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
}
