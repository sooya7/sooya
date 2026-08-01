import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/core/types.js';
import { ReplyCoordinator } from '../src/core/reply-coordinator.js';

const message = (id: string, role: 'user' | 'assistant'): ChatMessage => ({
  id, conversationId: 'main', role, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  seq: Number(id.replace(/\D/g, '') || 1), status: role === 'assistant' ? 'sent' : 'sent', content: [{ id: `${id}-part`, type: 'text', text: id, status: 'sent' }]
});

const options = { recentMessages: 24, memoryLimit: 8 };

describe('ReplyCoordinator', () => {
  let coordinator: ReplyCoordinator | undefined;

  afterEach(async () => {
    await coordinator?.stop();
  });

  it('recovers the trailing user tail after restart without duplicating it', async () => {
    const user1 = message('user-1', 'user');
    const user2 = message('user-2', 'user');
    const messages = { recent: vi.fn(() => [message('assistant-0', 'assistant'), user1, user2]) };
    const replyBatch = vi.fn(async () => ({ messageId: 'assistant-1', ok: true, parts: ['text'], degraded: [] }));
    const bus = { publish: vi.fn() };
    coordinator = new ReplyCoordinator({ messages: messages as never, replier: { replyBatch } as never, bus: bus as never, debounceMs: 0 });

    coordinator.recover(options);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replyBatch).toHaveBeenCalledTimes(1);
    expect(replyBatch.mock.calls[0]![0]).toEqual([user1, user2]);
    expect(bus.publish).toHaveBeenCalledWith('reply.queued', { count: 1, latestMessageId: 'user-1' });
    expect(bus.publish).toHaveBeenCalledWith('reply.queued', { count: 2, latestMessageId: 'user-2' });
  });
});
