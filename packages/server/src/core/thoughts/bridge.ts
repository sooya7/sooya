import type { ChatMessage } from '../types.js';

/**
 * The seam the ReplyCoordinator uses to hand over to the visible-thoughts
 * layer. Optional: when no bridge is wired, the coordinator behaves exactly
 * as before (zero behaviour change, all existing coordinator tests pass).
 *
 * Both methods must be cheap and never throw into the reply path.
 */
export interface ThoughtsBridge {
  /**
   * The reply for this batch is fully published (barrier open, message
   * persisted). The bridge fires the thought generation asynchronously and
   * may record the admin decision trace; nothing here may block or break
   * the reply.
   */
  beginForReply(input: {
    batchId: string;
    revision: number;
    messageId: string;
    userMessages: ChatMessage[];
    finalReply: string;
    degraded: string[];
  }): void;

  /**
   * A newer user message landed (or the coordinator is shutting down):
   * thoughts that are still generating must be cancelled — a not-yet-
   * published thought can never attach to a reply the user has moved past.
   */
  onUserActivity(): void;
}
