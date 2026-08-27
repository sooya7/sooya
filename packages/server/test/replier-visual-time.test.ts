import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, MessagePart, StreamEventType } from '../src/core/types.js';
import type { GenerationOptions } from '../src/core/replier.js';
import { resolveVisualTime } from '../src/core/visual-time.js';
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

  it('uses the final media plan when an explicit user image request has no model marker', async () => {
    harness = await createHarness({
      clock: () => new Date(NOW),
      image: 'ok',
      chat: { script: [['现在就是晚上。']] }
    });

    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: {
        clientMsgId: 'visual-time-user-image-plan',
        content: [{ type: 'text', text: '发一张照片：晚上睡觉' }]
      }
    });

    expect(response.statusCode).toBe(200);
    const reply = response.json().reply as ChatMessage;
    expect(reply.content.find((part) => part.type === 'image')?.status).toBe('sent');
    expect(reply.content.find((part) => part.type === 'text')?.text)
      .toBe('现在还是中午，不过昨天倒是有一张这种。');
  });

  it('does not claim an image when a model selfie marker cannot enter the final media plan', async () => {
    harness = await createHarness({
      clock: () => new Date(NOW),
      image: 'off',
      chat: { script: [['现在就是晚上。[[image-self:卧室里的夜间自拍]]']] }
    });

    const generated = await harness.app.services.replier.generateText(
      [userMessage('说说昨天晚上')],
      generationOptions()
    );

    expect(generated.visualTime.mode).toBe('retrospective');
    expect(generated.directives.selfImagePrompt).toBe('卧室里的夜间自拍');
    expect(generated.text).toBe('现在就是晚上。');
  });

  it('resolves 再来一张 from the latest non-empty batch message instead of stale night text', async () => {
    harness = await createHarness({
      clock: () => new Date(NOW),
      chat: { script: [['现在正好是中午。']] }
    });
    const first = userMessage('给我一张晚上睡觉的照片');
    const latest = userMessage('算了，再来一张');

    const generated = await harness.app.services.replier.generateText(
      [first, latest],
      generationOptions()
    );

    expect(generated.visualTime).toMatchObject({
      mode: 'current',
      currentDayPeriod: 'midday',
      depictedDayPeriod: 'midday',
      requestedDayPeriod: null
    });
  });

  it('uses the last batch message when separate messages request different day periods', async () => {
    harness = await createHarness({
      clock: () => new Date(NOW),
      chat: { script: [['昨晚倒是有一张这种。']] }
    });
    const first = userMessage('先发一张早上的照片');
    const latest = userMessage('还是要晚上睡觉的照片');

    const generated = await harness.app.services.replier.generateText(
      [first, latest],
      generationOptions()
    );

    expect(generated.visualTime).toMatchObject({
      mode: 'retrospective',
      depictedDayPeriod: 'evening',
      requestedDayPeriod: 'evening'
    });
  });

  it('keeps the visual-time hard rule when a long user turn fills a small context budget', async () => {
    harness = await createHarness({ clock: () => new Date(NOW) });
    const longText = `发一张晚上睡觉的照片。${'这是一段很长的用户上下文。'.repeat(600)}`;
    const message = userMessage(longText);
    const visualTime = resolveVisualTime({
      now: NOW,
      timeZone: 'Asia/Shanghai',
      latestUserText: '发一张晚上睡觉的照片'
    });

    const built = await harness.app.services.context.build(
      harness.app.config.getPersona(),
      longText,
      {
        recentMessages: 24,
        memoryLimit: 0,
        batchMessageIds: [message.id],
        allowVision: false,
        voiceMoods: '',
        capabilityNotes: [],
        contextWindow: 400,
        maxOutputTokens: 16,
        visualTime
      }
    );

    expect(built.system).toContain('视觉时间规则（双时钟）');
    expect(built.system).toContain('2026-08-26T05:17:23.000Z');
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(built.inputBudget);
    const retainedUserText = built.turns.flatMap((turn) => turn.content)
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    expect(retainedUserText.length).toBeGreaterThan(0);
    expect(retainedUserText.length).toBeLessThan(longText.length);
  });

  it('shares one world snapshot across reply context and image publication', async () => {
    harness = await createHarness({
      clock: () => new Date(NOW),
      image: 'ok',
      chat: { script: [['现在就是晚上。']] }
    });
    const snapshot = vi.spyOn(harness.app.services.world, 'snapshot');

    const response = await harness.app.server.inject({
      method: 'POST',
      url: '/api/messages/sync',
      payload: {
        clientMsgId: 'visual-time-one-world-snapshot',
        content: [{ type: 'text', text: '发一张自拍：晚上睡觉' }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().reply.content.find((part: MessagePart) => part.type === 'image')?.status).toBe('sent');
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});
