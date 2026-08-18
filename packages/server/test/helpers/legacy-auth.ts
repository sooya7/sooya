import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SooyaApp } from '../../src/app.js';

/** Test-only compatibility guard. Production Web chat auth no longer exists. */
export function requireChatToken(_app: SooyaApp) {
  return async (_req: FastifyRequest, _reply: FastifyReply): Promise<void> => undefined;
}
