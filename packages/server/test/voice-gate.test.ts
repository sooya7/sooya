import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';
import { image as imageCall, voice, withMediaTools } from './helpers/media-tools.js';

/**
 * Voice goes out only when the user asks for it or the reply calls send_voice.
 * A [[voice]] marker she writes out of habit does nothing, and a picture call
 * is not a voice request.
 */

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const partTypes = (reply: { content: Array<{ type: string }> }) => reply.content.map((part) => part.type);

describe('where voice comes from', () => {
  it('ignores a [[voice]] marker she writes on her own', async () => {
    h = await createHarness({ tts: 'ok', chat: { script: [['晚安呀～[[voice]]']] } });
    const { body } = await sendText(h.app, '我要睡啦');
    expect(h.state.ttsCalls).toBe(0);
    expect(partTypes(body.reply)).toEqual(['text']);
    expect(body.reply.content[0].text).toBe('晚安呀～');
  });

  it('does not voice a reply that only calls send_image', async () => {
    h = await createHarness(withMediaTools('画好啦～[[voice]]', [imageCall('一只橘猫蜷在窗台上睡觉')], { image: 'ok', tts: 'ok' }));
    const { body } = await sendText(h.app, '画只猫给我');
    expect(h.state.imageCalls).toBe(1);
    expect(h.state.ttsCalls).toBe(0);
    expect(partTypes(body.reply)).not.toContain('audio');
  });

  it('voices a reply that calls send_voice', async () => {
    h = await createHarness(withMediaTools('晚安，早点睡～', [voice()], { tts: 'ok' }));
    const { body } = await sendText(h.app, '跟我说晚安');
    expect(h.state.ttsCalls).toBe(1);
    expect(partTypes(body.reply)).toEqual(['text', 'audio']);
  });

  it('voices a reply the user asked to hear, with no tool call', async () => {
    h = await createHarness({ tts: 'ok', chat: { script: [['晚安～']] } });
    const { body } = await sendText(h.app, '用语音说晚安');
    expect(h.state.ttsCalls).toBe(1);
    expect(partTypes(body.reply)).toContain('audio');
  });
});
