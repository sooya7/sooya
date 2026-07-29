import type { ChatMessage } from './types.js';

/**
 * Reconnect catch-up helpers (H6/H10).
 *
 * The server caps every `?since=` page, so a client that fell far behind must
 * walk the cursor instead of assuming one request returns everything. These are
 * pure functions so the paging and resend-reconciliation rules are testable
 * without mounting the hook.
 */

/** Hard stop so a misbehaving cursor can never spin forever. */
export const MAX_CATCHUP_PAGES = 100;

export class MessageSyncError extends Error {
  constructor(message: string, readonly pagesFetched: number) {
    super(message);
    this.name = 'MessageSyncError';
  }
}

export interface CatchUpPage {
  messages: ChatMessage[];
  hasMore: boolean;
  nextSince?: number;
}

export type CatchUpFetcher = (since: number) => Promise<CatchUpPage>;

/** Highest seq in a page, or `null` when the page is empty. */
function lastSeq(messages: ChatMessage[]): number | null {
  let max: number | null = null;
  for (const m of messages) if (max === null || m.seq > max) max = m.seq;
  return max;
}

/**
 * Walk `?since=` pages from `since` until the server reports no more, and
 * return every message once, oldest first.
 *
 * Throws `MessageSyncError` rather than looping forever when the server claims
 * `hasMore` but hands back a cursor that cannot advance, or when the backlog
 * exceeds `MAX_CATCHUP_PAGES` pages.
 */
export async function fetchAllMessagePages(since: number, fetchPage: CatchUpFetcher): Promise<ChatMessage[]> {
  const byId = new Map<string, ChatMessage>();
  let cursor = since;
  let pages = 0;

  for (;;) {
    const page = await fetchPage(cursor);
    pages += 1;
    for (const message of page.messages) byId.set(message.id, message);

    if (!page.hasMore) break;

    // Prefer the server cursor; fall back to the page's own high-water seq so an
    // older server without `nextSince` still makes progress.
    const next = page.nextSince ?? lastSeq(page.messages) ?? cursor;
    if (next <= cursor) {
      throw new MessageSyncError(`catch-up cursor stalled at seq ${cursor}`, pages);
    }
    cursor = next;

    if (pages >= MAX_CATCHUP_PAGES) {
      throw new MessageSyncError(`catch-up exceeded ${MAX_CATCHUP_PAGES} pages`, pages);
    }
  }

  return [...byId.values()].sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.createdAt.localeCompare(b.createdAt)));
}

/**
 * Swap a failed optimistic row for the server row a retry produced.
 *
 * Resend reuses the original `clientMsgId`, so the server dedupes it to the
 * same message. Matching on `clientMsgId` (not local id) is what keeps a retry
 * from leaving a duplicate failed bubble behind.
 */
export function replaceFailedMessage(list: ChatMessage[], clientMsgId: string, saved: ChatMessage): ChatMessage[] {
  const kept = list.filter((m) => {
    if (m.id === saved.id) return false; // replaced below
    if (!m.clientMsgId || m.clientMsgId !== clientMsgId) return true;
    // Drop the local placeholder / failed attempt this save supersedes.
    return !(m.pendingLocal || m.status === 'failed' || m.status === 'pending');
  });
  return [...kept, saved].sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.createdAt.localeCompare(b.createdAt)));
}
