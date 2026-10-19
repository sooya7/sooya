import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';
import { DEFAULT_VOICE_PREFERENCES } from '../src/core/voice/types.js';

/**
 * Voice she starts herself (a [[voice]] marker) is held back by the auto
 * frequency and the daily cap; an explicit send_voice call is not. An image or
 * video call is not a voice request.
 */

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

function fakeChat(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function toolCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return {
    content: '',
    tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  };
}

function toolRoundOnce(call: () => Record<string, unknown>) {
  let rounds = 0;
  return ({ body }: { body: unknown }): Response | null => {
    const b = body as { stream?: boolean; tools?: unknown[] };
    if (b.stream === true || !Array.isArray(b.tools)) return null;
    rounds += 1;
    return fakeChat(rounds === 1 ? call() : { content: '' });
  };
}

const partTypes = (reply: { content: Array<{ type: string }> }) => reply.content.map((part) => part.type);

function setFrequency(harness: Harness, autoVoiceFrequency: 'never' | 'rare' | 'sometimes') {
  harness.app.repos.settings.set('voice.preferences', { ...DEFAULT_VOICE_PREFERENCES, autoVoiceFrequency });
}

describe('voice she starts herself', () => {
  it('counts her own voices toward the daily cap, not the ones the user asked for', async () => {
    h = await createHarness({ startWorkers: false });
    const since = new Date(Date.now() - 60_000).toISOString();
    for (const requestedBy of ['model', 'auto', 'user', 'proactive'] as const) {
      h.app.repos.voice.create({
        batchId: `b_${requestedBy}`, revision: 1, mode: 'complement', requestedBy,
        status: 'published', spokenText: '晚安', synthesisText: '晚安'
      });
    }
    expect(h.app.repos.voice.countAutoSince(since)).toBe(2);
  });

  it('sends the marker voice while the frequency allows it', async () => {
    h = await createHarness({ tts: 'ok', chat: { script: [['晚安呀～[[voice]]']] } });
    setFrequency(h, 'rare');
    const { body } = await sendText(h.app, '我要睡啦');
    expect(h.state.ttsCalls).toBe(1);
    expect(partTypes(body.reply)).toContain('audio');
  });

  it('stops the marker voice once today’s cap is used up by her own voices', async () => {
    h = await createHarness({ tts: 'ok', env: { VOICE_DAILY_AUTO_CAP: '1' }, chat: { script: [['晚安呀～[[voice]]']] } });
    setFrequency(h, 'rare');
    h.app.repos.voice.create({
      batchId: 'b_earlier', revision: 1, mode: 'complement', requestedBy: 'model',
      status: 'published', spokenText: '早安', synthesisText: '早安'
    });
    const { body } = await sendText(h.app, '我要睡啦');
    expect(h.state.ttsCalls).toBe(0);
    expect(partTypes(body.reply)).not.toContain('audio');
  });

  it('does not let a picture call carry a marker voice past frequency never', async () => {
    h = await createHarness({
      chatSupportsTools: true,
      image: 'ok',
      tts: 'ok',
      env: { MEDIA_TOOLS_ENABLED: 'true' },
      chat: {
        script: [['画好啦～[[voice]]']],
        respond: toolRoundOnce(() => toolCall('send_image', { intent: '一只橘猫蜷在窗台上睡觉' }))
      }
    });
    setFrequency(h, 'never');
    const { body } = await sendText(h.app, '画只猫给我');
    expect(h.state.imageCalls).toBe(1);
    expect(h.state.ttsCalls).toBe(0);
    expect(partTypes(body.reply)).not.toContain('audio');
  });

  it('still honors an explicit send_voice call with frequency never', async () => {
    h = await createHarness({
      chatSupportsTools: true,
      tts: 'ok',
      env: { MEDIA_TOOLS_ENABLED: 'true' },
      chat: {
        script: [['晚安，早点睡～']],
        respond: toolRoundOnce(() => toolCall('send_voice', { mode: 'with_text' }))
      }
    });
    setFrequency(h, 'never');
    const { body } = await sendText(h.app, '跟我说晚安');
    expect(h.state.ttsCalls).toBe(1);
    expect(partTypes(body.reply)).toEqual(['text', 'audio']);
  });
});
