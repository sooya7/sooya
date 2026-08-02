import { describe, expect, it } from 'vitest';
import { estimateTextTokens, lastUserMessageAt } from '../src/core/context.js';
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

describe('token estimation', () => {
  it('counts CJK conservatively so long Chinese text does not blow the context window', () => {
    expect(estimateTextTokens('中文')).toBe(3);
    expect(estimateTextTokens('hello')).toBe(2);
    expect(estimateTextTokens('')).toBe(0);
  });
});

function message(id: string, createdAt: string): ChatMessage {
  return {
    id, conversationId: 'main', role: 'user', createdAt, updatedAt: createdAt,
    seq: 1, status: 'sent', content: [{ id: `${id}-part`, type: 'text', text: id, status: 'sent' }]
  };
}
