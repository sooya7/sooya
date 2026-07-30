// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The voice bubble rendered garbled: the duration text sat on top of the waveform.
 *
 * Cause was a geometry contradiction. `width` was computed as `70 + duration * 3.2` and
 * applied to the **whole bubble**, but the bubble also holds fixed furniture -- padding,
 * the play button, three gaps, the duration and the speed toggle -- worth ~140px. A 12s
 * clip therefore asked for 110px, less than the furniture alone, leaving the waveform
 * negative space; its bars carried `min-width: 2px` so they could not shrink, and they
 * overflowed a 40px-wide, 5px-tall track straight over the duration and speed button.
 *
 * jsdom has no layout engine, so these tests assert that contract -- the bubble is wide
 * enough for the bars it renders plus the furniture -- rather than pixel positions.
 */

const media = { url: 'blob:fake', error: null as string | null, retriable: false, retry: vi.fn() };
vi.mock('../lib/useAuthenticatedMedia.js', () => ({
  useAuthenticatedMedia: () => media
}));

const { AudioBubble, BAR_W, BAR_GAP, BUBBLE_CHROME_W } = await import('./AudioBubble.js');
type MessagePart = import('../lib/types.js').MessagePart;

const MAX_W = 300;

function part(over: Partial<MessagePart> = {}): MessagePart {
  return {
    id: 'part-1',
    type: 'audio',
    status: 'sent',
    media: {
      id: 'media-abc',
      kind: 'audio',
      mime: 'audio/mp4',
      bytes: 1024,
      url: '/api/media/1'
    },
    ...over
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function draw(over: Partial<MessagePart> = {}) {
  act(() => root.render(<AudioBubble part={part(over)} mine={false} />));
  const bubble = host.querySelector('.bubble-audio') as HTMLElement;
  return {
    width: Number.parseFloat(bubble.style.width),
    bars: host.querySelectorAll('.audio-wave i').length,
    duration: host.querySelector('[data-testid="audio-duration"]')?.textContent
  };
}

describe('AudioBubble layout', () => {
  it.each([
    ['no duration', undefined],
    ['short', 3],
    ['typical', 12.5],
    ['long', 45],
    ['ten minutes', 600]
  ])('leaves room for every waveform bar (%s)', (_label, duration) => {
    const { width, bars } = draw({ duration });

    expect(bars).toBeGreaterThan(0);
    const needed = BUBBLE_CHROME_W + bars * (BAR_W + BAR_GAP) - BAR_GAP;
    expect(width).toBeGreaterThanOrEqual(Math.min(needed, MAX_W));
  });

  it('never renders narrower than its own furniture', () => {
    expect(draw().width).toBeGreaterThan(BUBBLE_CHROME_W);
  });

  it('caps the width so a long clip cannot run off a phone screen', () => {
    expect(draw({ duration: 600 }).width).toBeLessThanOrEqual(MAX_W);
  });

  it('grows with duration', () => {
    const short = draw({ duration: 2 }).width;
    act(() => root.unmount());
    root = createRoot(host);
    const long = draw({ duration: 40 }).width;

    expect(long).toBeGreaterThan(short);
  });

  it('shows the known duration rather than 0:00', () => {
    expect(draw({ duration: 12.5 }).duration).toBe('0:12');
  });
});
