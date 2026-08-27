import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, StreamEventType } from '../src/core/types.js';
import type { GenerationOptions } from '../src/core/replier.js';
import { createHarness, type Harness } from './helpers/harness.js';

const NOW = new Date('2026-08-26T05:17:23.000Z');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function userMessage(text: string): ChatMessage {
  return harness!.app.repos.messages.create({
    role: 'user',
    status: 'sent',
    parts: [{ type: 'text', text }]
  }).message;
}

function generationOptions(beginPublish = vi.fn(async () => true)): GenerationOptions {
  return {
    signal: new AbortController().signal,
    batchId: 'visual-time-test',
    revision: 1,
    owner: 'visual-time-test',
    publishGraceMs: 0,
    requestTimeoutMs: 5_000,
    beginPublish,
    recentMessages: 24,
    memoryLimit: 8
  };
}

function requestSystem(): string {
  const body = harness!.state.chatCalls.at(-1)?.body as {
    messages?: Array<{ role?: string; content?: string }>;
  } | undefined;
  return body?.messages?.find((message) => message.role === 'system')?.content ?? '';
}

describe('Replier visual-time planning', () => {
  it('pins the real 13:17 clock and turns a conflicting night image into the previous local day', async () => {
    harness = await createHarness({
      clock: () => new Date(NOW),
      chat: { script: [['现在是晚上，准备睡了[[image:晚上睡觉]]']] }
    });
    const publish = vi.fn(async () => true);

    const generated = await harness.app.services.replier.generateText(
      [userMessage('给我一张晚上睡觉的照片')],
      generationOptions(publish)
    );

    const system = requestSystem();
    expect(system).toContain('2026-08-26');
    expect(system).toContain('13:17:23');
    expect(system).toContain('Asia/Shanghai');
    expect(system).toContain('2026-08-26T05:17:23.000Z');
    expect(system).toContain('真实时间不可被改写');
    expect(system).toContain('2026-08-25');
    expect(system).toContain('现在还是中午，不过昨天倒是有一张这种。');
    expect(generated.visualTime).toMatchObject({
      currentLocalDate: '2026-08-26',
      currentLocalTime: '13:17:23',
      currentDayPeriod: 'midday',
      mode: 'retrospective',
      depictedLocalDate: '2026-08-25',
      depictedDayPeriod: 'evening'
    });
  });

  it('holds a retrospective image draft until directives are known and fixes its final wording', async () => {
    harness = await createHarness({
      clock: () => new Date(NOW),
      chat: { script: [['现在就是晚上', '，该睡觉了', '[[image:卧室夜景]]']] }
    });
    const publish = vi.fn(async () => true);
    const publishedEvents: StreamEventType[] = [];
    vi.spyOn(harness.app.services.bus, 'publish').mockImplementation((type) => {
      publishedEvents.push(type);
    });

    const generated = await harness.app.services.replier.generateText(
      [userMessage('发一张晚上睡觉的照片')],
      generationOptions(publish)
    );

    expect(generated.published).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(publishedEvents).not.toContain('reply.text.delta');
    expect(publishedEvents).not.toContain('reply.text.done');
    expect(generated.directives.imagePrompt).toBe('卧室夜景');
    expect(generated.text).toBe('现在还是中午，不过昨天倒是有一张这种。');
  });

  it('does not rewrite current or no-image replies', async () => {
    harness = await createHarness({
      clock: () => new Date(NOW),
      chat: { script: [['现在正好是中午。'], ['现在挺安静的。']] }
    });

    const current = await harness.app.services.replier.generateText(
      [userMessage('说说现在')],
      generationOptions()
    );
    const retrospectiveWithoutImage = await harness.app.services.replier.generateText(
      [userMessage('说说昨天晚上')],
      { ...generationOptions(), batchId: 'visual-time-no-image' }
    );

    expect(current.visualTime.mode).toBe('current');
    expect(current.text).toBe('现在正好是中午。');
    expect(retrospectiveWithoutImage.visualTime.mode).toBe('retrospective');
    expect(retrospectiveWithoutImage.text).toBe('现在挺安静的。');
  });

  it('does not claim a past image when a retrospective image directive has no prompt', async () => {
    harness = await createHarness({
      clock: () => new Date(NOW),
      chat: { script: [['现在就是晚上。[[image:]]']] }
    });

    const generated = await harness.app.services.replier.generateText(
      [userMessage('发一张晚上睡觉的照片')],
      generationOptions()
    );

    expect(generated.visualTime.mode).toBe('retrospective');
    expect(generated.directives.imagePrompt).toBeNull();
    expect(generated.text).toBe('现在就是晚上。');
  });
});
