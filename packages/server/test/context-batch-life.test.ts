import { describe, expect, it } from 'vitest';
import { lastUserMessageAt } from '../src/core/context.js';
import type { ChatMessage } from '../src/core/types.js';

describe('life context batch boundary', () => {
  it('uses the previous user turn rather than any message in the current batch', () => {
    const recent = [
      message('previous', '2026-08-01T00:00:00.000Z'),
      message('batch-1', '2026-08-01T00:10:00.000Z'),
      message('batch-2', '2026-08-01T00:10:00.500Z')
    ];

    expect(lastUserMessageAt(recent, ['batch-1', 'batch-2'])?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});

function message(id: string, createdAt: string): ChatMessage {
  return {
    id, conversationId: 'main', role: 'user', createdAt, updatedAt: createdAt,
    seq: 1, status: 'sent', content: [{ id: `${id}-part`, type: 'text', text: id, status: 'sent' }]
  };
}
