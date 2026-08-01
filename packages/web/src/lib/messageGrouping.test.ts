import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './types.js';
import { dateLabel, localDateKey, shouldStartDateSeparator, shouldStartMessageGroup } from './messageGrouping.js';

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1', conversationId: 'main', role: 'user', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  seq: 1, status: 'sent', content: [{ id: 'p1', type: 'text', text: 'hello', status: 'sent' }], ...overrides
});

describe('message temporal grouping', () => {
  it('keeps same-role messages together for five minutes', () => {
    expect(shouldStartMessageGroup(message(), message({ id: 'm2', createdAt: '2026-08-01T00:04:59.000Z' }), 'UTC')).toBe(false);
    expect(shouldStartMessageGroup(message(), message({ id: 'm3', createdAt: '2026-08-01T00:05:01.000Z' }), 'UTC')).toBe(true);
    expect(shouldStartMessageGroup(message(), message({ id: 'm4', role: 'assistant' }), 'UTC')).toBe(true);
  });

  it('uses the selected timezone for date boundaries', () => {
    const previous = message({ createdAt: '2026-08-01T23:30:00.000Z' });
    const current = message({ id: 'm2', createdAt: '2026-08-02T00:30:00.000Z' });
    expect(localDateKey(previous.createdAt, 'Asia/Shanghai')).toBe('2026-08-02');
    expect(localDateKey(current.createdAt, 'Asia/Shanghai')).toBe('2026-08-02');
    expect(localDateKey(previous.createdAt, 'America/New_York')).toBe('2026-08-01');
    expect(localDateKey(current.createdAt, 'America/New_York')).toBe('2026-08-01');
    expect(shouldStartDateSeparator(previous, current, 'UTC')).toBe(true);
  });

  it('labels today, yesterday and older dates consistently', () => {
    const now = new Date('2026-08-02T00:30:00.000Z');
    expect(dateLabel('2026-08-02T00:20:00.000Z', now, 'Asia/Shanghai')).toBe('今天');
    expect(dateLabel('2026-08-01T00:20:00.000Z', now, 'Asia/Shanghai')).toBe('昨天');
    expect(dateLabel('2026-07-31T00:20:00.000Z', now, 'Asia/Shanghai')).toBe('2026年7月31日');
  });

  it('starts a new group for proactive messages and withdrawn placeholders', () => {
    expect(shouldStartMessageGroup(message(), message({ id: 'm2', meta: { proactive: true } }), 'UTC')).toBe(true);
    expect(shouldStartMessageGroup(message(), message({ id: 'm3', meta: { withdrawnAt: '2026-08-01T00:01:00.000Z' } }), 'UTC')).toBe(true);
  });
});
