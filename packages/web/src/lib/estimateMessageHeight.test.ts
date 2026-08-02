import { describe, expect, it } from 'vitest';
import { estimateMessageHeight } from './estimateMessageHeight.js';
import type { ChatMessage, MessagePart } from './types.js';

function part(id: string, type: MessagePart['type'], overrides: Partial<MessagePart> = {}): MessagePart {
  return { id, type, status: 'sent', text: null, mediaId: null, ...overrides };
}

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    conversationId: 'main',
    role: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    seq: 1,
    status: 'sent',
    content: [],
    ...overrides
  };
}

const sameDayPrev = message('prev', { createdAt: '2026-08-01T10:00:00.000Z' });

describe('estimateMessageHeight', () => {
  it('estimates a single-line text message', () => {
    const msg = message('t1', { content: [part('p', 'text', { text: '你好' })] });
    expect(estimateMessageHeight(msg, sameDayPrev)).toBe(72.5);
  });

  it('grows with text length across line breaks', () => {
    const single = estimateMessageHeight(message('a', { content: [part('p', 'text', { text: '短文本' })] }), sameDayPrev);
    const multi = estimateMessageHeight(message('b', { content: [part('p', 'text', { text: 'x'.repeat(200) })] }), sameDayPrev);
    expect(multi).toBeGreaterThan(single);
  });

  it('sizes images from their aspect ratio, capped at the 260px bubble', () => {
    const square = message('i1', { content: [part('p', 'image', { media: { id: 'm1', kind: 'image', mime: 'image/png', bytes: 1, width: 500, height: 500, url: '/m1' } })] });
    const wide = message('i2', { content: [part('p', 'image', { media: { id: 'm2', kind: 'image', mime: 'image/png', bytes: 1, width: 800, height: 400, url: '/m2' } })] });
    const unknown = message('i3', { content: [part('p', 'image', { media: { id: 'm3', kind: 'image', mime: 'image/png', bytes: 1, url: '/m3' } })] });
    expect(estimateMessageHeight(square, sameDayPrev)).toBe(292);
    expect(estimateMessageHeight(wide, sameDayPrev)).toBe(162);
    expect(estimateMessageHeight(unknown, sameDayPrev)).toBe(292);
  });

  it('orders media sizes: sticker > audio/file > single text', () => {
    const sticker = estimateMessageHeight(message('s', { content: [part('p', 'sticker', { media: { id: 'm', kind: 'sticker', mime: 'image/webp', bytes: 1, url: '/m' } })] }), sameDayPrev);
    const audio = estimateMessageHeight(message('a', { content: [part('p', 'audio', { media: { id: 'm', kind: 'audio', mime: 'audio/mpeg', bytes: 1, url: '/m' } })] }), sameDayPrev);
    const file = estimateMessageHeight(message('f', { content: [part('p', 'file', { media: { id: 'm', kind: 'file', mime: 'application/pdf', bytes: 1, url: '/m' } })] }), sameDayPrev);
    const text = estimateMessageHeight(message('t', { content: [part('p', 'text', { text: 'hi' })] }), sameDayPrev);
    expect(sticker).toBe(140);
    expect(audio).toBe(80);
    expect(file).toBe(82);
    expect(sticker).toBeGreaterThan(audio);
    expect(audio).toBeGreaterThan(text);
  });

  it('adds the inter-part gap when a message has several parts', () => {
    const two = estimateMessageHeight(
      message('m', { content: [part('p1', 'text', { text: '看这个' }), part('p2', 'sticker', { media: { id: 'm', kind: 'sticker', mime: 'image/webp', bytes: 1, url: '/m' } })] }),
      sameDayPrev
    );
    const single = estimateMessageHeight(message('m', { content: [part('p', 'sticker', { media: { id: 'm', kind: 'sticker', mime: 'image/webp', bytes: 1, url: '/m' } })] }), sameDayPrev);
    expect(two).toBe(single + 40.5 + 6);
  });

  it('keeps system messages compact', () => {
    const msg = message('sys', { role: 'system', content: [part('p', 'system', { text: '对方撤回了一条消息' })] });
    expect(estimateMessageHeight(msg, sameDayPrev)).toBe(36);
  });

  it('adds a date separator height when the previous message is on another day', () => {
    const msg = message('t', { content: [part('p', 'text', { text: '你好' })] });
    const noSep = estimateMessageHeight(msg, sameDayPrev);
    const sep = estimateMessageHeight(msg, message('old', { createdAt: '2026-06-15T00:00:00.000Z' }));
    expect(sep).toBe(noSep + 35);
  });

  it('reserves room for the reply preview when replyTo is set', () => {
    const plain = estimateMessageHeight(message('t', { content: [part('p', 'text', { text: '你好' })] }), sameDayPrev);
    const quoted = estimateMessageHeight(message('t', { replyTo: 'prev-msg', content: [part('p', 'text', { text: '你好' })] }), sameDayPrev);
    expect(quoted).toBe(plain + 44);
  });
});
