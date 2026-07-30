import { describe, it, expect, vi } from 'vitest';
import { fetchAllMessagePages, replaceFailedMessage, MessageSyncError, MAX_CATCHUP_PAGES, type CatchUpPage } from './messageSync.js';
import type { ChatMessage } from './types.js';

function msg(seq: number, over: Partial<ChatMessage> = {}): ChatMessage {
  // Optimistic rows use a near-MAX_SAFE_INTEGER seq, so clamp before building a date.
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, Math.min(seq, 86_000))).toISOString();
  return {
    id: over.id ?? `m${seq}`,
    conversationId: 'main',
    role: 'user',
    createdAt: at,
    updatedAt: at,
    seq,
    status: 'sent',
    content: [],
    ...over,
  } as ChatMessage;
}

/** Page a fixed corpus the way the server does, `limit` at a time. */
function serverLike(all: ChatMessage[], limit: number): (since: number) => Promise<CatchUpPage> {
  return async (since: number) => {
    const after = all.filter((m) => m.seq > since).sort((a, b) => a.seq - b.seq);
    const page = after.slice(0, limit);
    return {
      messages: page,
      hasMore: after.length > limit,
      nextSince: page[page.length - 1]?.seq ?? since,
    };
  };
}

describe('fetchAllMessagePages', () => {
  it('returns a single page as-is when the server says there is no more', async () => {
    const all = [msg(1), msg(2)];
    const out = await fetchAllMessagePages(0, serverLike(all, 10));
    expect(out.map((m) => m.seq)).toEqual([1, 2]);
  });

  it('walks every page and returns messages oldest-first', async () => {
    const all = Array.from({ length: 25 }, (_, i) => msg(i + 1));
    const out = await fetchAllMessagePages(0, serverLike(all, 10));
    expect(out.map((m) => m.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('issues one request per page plus the terminating page', async () => {
    const all = Array.from({ length: 20 }, (_, i) => msg(i + 1));
    const fetchPage = vi.fn(serverLike(all, 10));
    await fetchAllMessagePages(0, fetchPage);
    // 1..10 (hasMore), 11..20 (no more)
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 10);
  });

  it('starts from the supplied cursor, not from zero', async () => {
    const all = Array.from({ length: 12 }, (_, i) => msg(i + 1));
    const fetchPage = vi.fn(serverLike(all, 5));
    const out = await fetchAllMessagePages(8, fetchPage);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 8);
    expect(out.map((m) => m.seq)).toEqual([9, 10, 11, 12]);
  });

  it('de-duplicates a message that appears in two pages', async () => {
    const pages: CatchUpPage[] = [
      { messages: [msg(1), msg(2)], hasMore: true, nextSince: 2 },
      { messages: [msg(2), msg(3)], hasMore: false, nextSince: 3 },
    ];
    const out = await fetchAllMessagePages(0, async () => pages.shift()!);
    expect(out.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('returns an empty array when there is nothing to catch up on', async () => {
    const out = await fetchAllMessagePages(7, async () => ({ messages: [], hasMore: false, nextSince: 7 }));
    expect(out).toEqual([]);
  });

  it('falls back to the page high-water seq when nextSince is absent', async () => {
    const seen: number[] = [];
    const all = Array.from({ length: 8 }, (_, i) => msg(i + 1));
    const out = await fetchAllMessagePages(0, async (since) => {
      seen.push(since);
      const after = all.filter((m) => m.seq > since);
      const page = after.slice(0, 4);
      return { messages: page, hasMore: after.length > 4 }; // no nextSince
    });
    expect(seen).toEqual([0, 4]);
    expect(out.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('throws instead of looping when hasMore is set but the cursor cannot advance', async () => {
    const fetchPage = vi.fn(async () => ({ messages: [], hasMore: true, nextSince: 0 }));
    await expect(fetchAllMessagePages(0, fetchPage)).rejects.toThrow(MessageSyncError);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws instead of looping when the cursor moves backwards', async () => {
    await expect(
      fetchAllMessagePages(10, async () => ({ messages: [msg(11)], hasMore: true, nextSince: 5 })),
    ).rejects.toThrow(/stalled/);
  });

  it('stops after MAX_CATCHUP_PAGES and reports how far it got', async () => {
    let seq = 0;
    const fetchPage = vi.fn(async () => {
      seq += 1;
      return { messages: [msg(seq)], hasMore: true, nextSince: seq };
    });
    const err = await fetchAllMessagePages(0, fetchPage).catch((e) => e);
    expect(err).toBeInstanceOf(MessageSyncError);
    expect((err as MessageSyncError).pagesFetched).toBe(MAX_CATCHUP_PAGES);
    expect(fetchPage).toHaveBeenCalledTimes(MAX_CATCHUP_PAGES);
  });

  it('propagates a transport failure to the caller', async () => {
    await expect(fetchAllMessagePages(0, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
});

describe('replaceFailedMessage', () => {
  it('replaces the failed attempt with the saved server row', () => {
    const failed = msg(Number.MAX_SAFE_INTEGER - 1, { id: 'local_c1', clientMsgId: 'c1', status: 'failed', pendingLocal: true });
    const saved = msg(5, { id: 'srv5', clientMsgId: 'c1' });
    const out = replaceFailedMessage([msg(4), failed], 'c1', saved);
    expect(out.map((m) => m.id)).toEqual(['m4', 'srv5']);
  });

  it('keeps other clients\u2019 pending rows untouched', () => {
    const mine = msg(900, { id: 'local_c1', clientMsgId: 'c1', status: 'failed', pendingLocal: true });
    const other = msg(901, { id: 'local_c2', clientMsgId: 'c2', status: 'pending', pendingLocal: true });
    const saved = msg(5, { id: 'srv5', clientMsgId: 'c1' });
    const out = replaceFailedMessage([mine, other], 'c1', saved);
    expect(out.map((m) => m.id)).toEqual(['srv5', 'local_c2']);
  });

  it('is idempotent when the saved row is already present', () => {
    const saved = msg(5, { id: 'srv5', clientMsgId: 'c1' });
    const once = replaceFailedMessage([msg(4), saved], 'c1', saved);
    const twice = replaceFailedMessage(once, 'c1', saved);
    expect(twice.map((m) => m.id)).toEqual(['m4', 'srv5']);
    expect(twice.filter((m) => m.id === 'srv5')).toHaveLength(1);
  });

  it('does not drop an already-sent message that shares the clientMsgId', () => {
    const sent = msg(5, { id: 'srv5', clientMsgId: 'c1', status: 'sent' });
    const saved = msg(6, { id: 'srv6', clientMsgId: 'c1', status: 'sent' });
    const out = replaceFailedMessage([sent], 'c1', saved);
    expect(out.map((m) => m.id)).toEqual(['srv5', 'srv6']);
  });

  it('sorts the saved row into seq order rather than appending it', () => {
    const failed = msg(Number.MAX_SAFE_INTEGER - 1, { id: 'local_c1', clientMsgId: 'c1', status: 'failed', pendingLocal: true });
    const saved = msg(2, { id: 'srv2', clientMsgId: 'c1' });
    const out = replaceFailedMessage([msg(1), failed, msg(3)], 'c1', saved);
    expect(out.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});
