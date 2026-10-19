import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TTSOptions, TTSProvider } from '../src/providers/types.js';
import { createHarness, makeFakeMp3, sendText, type Harness } from './helpers/harness.js';
import { toolRoundOnce, voice } from './helpers/media-tools.js';

let harness: Harness | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (harness) await harness.cleanup();
  harness = null;
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };

/** A fake Fish-named provider that captures exactly what VoiceService sends. */
function captureProvider(calls: Array<{ text: string; options: TTSOptions | undefined }>): TTSProvider {
  return {
    name: 'fish',
    configured: true,
    synthesize: async (text, options) => {
      calls.push({ text, options });
      return { data: makeFakeMp3(), mime: 'audio/mpeg', format: 'mp3', durationSec: 1 };
    },
    inspectHealth: async () => ({ capability: 'tts', configured: true, ok: true })
  };
}

function cues(text: string): string[] {
  return text.match(/\[[^\]]+\]/g) ?? [];
}

describe('converged Fish path — one cue source, no double cue', () => {
  it('ships her text with at most one whitelist cue and the mood speed', async () => {
    harness = await createHarness({
      tts: 'ok',
      chatSupportsTools: true,
      env: { ADMIN_API_TOKEN: 'admin-test-token', MEDIA_TOOLS_ENABLED: 'true' },
      chat: {
        // Explicit user voice request → replace mode; send_voice carries the
        // mood the main model picked.
        script: [['我刚刚有点想你。']],
        respond: toolRoundOnce([voice('with_text', 'shy')])
      }
    });
    const calls: Array<{ text: string; options: TTSOptions | undefined }> = [];
    vi.spyOn(harness.app.services.capabilities, 'ttsProvider').mockReturnValue(captureProvider(calls));

    const reply = await sendText(harness.app, '用语音回我，我想你了', 'voice-fish-shy');
    expect(reply.res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    // Exactly one cue — the FishCueRenderer's, never a second one on top.
    expect(cues(calls[0]!.text)).toEqual(['[slightly shy]']);
    expect(calls[0]!.text).toBe('[slightly shy] 我刚刚有点想你。');
    // No rewrite any more: the pace comes from the mood table for the same cue
    // (send_voice carries no intensity, so the full-strength pace applies).
    expect(calls[0]!.options?.speed).toBe(0.98);
  });

  it('strips a stray cue from the director so the request still carries exactly one', async () => {
    harness = await createHarness({
      tts: 'ok',
      chatSupportsTools: true,
      env: { ADMIN_API_TOKEN: 'admin-test-token', MEDIA_TOOLS_ENABLED: 'true' },
      chat: {
        // The model drifted and wrote its own cue into the text;
        // sanitizeFishText removes it, then FishCueRenderer adds exactly one.
        script: [['[small chuckle] 我刚刚有点想你。']],
        respond: toolRoundOnce([voice('with_text', 'shy')])
      }
    });
    const calls: Array<{ text: string; options: TTSOptions | undefined }> = [];
    vi.spyOn(harness.app.services.capabilities, 'ttsProvider').mockReturnValue(captureProvider(calls));

    const reply = await sendText(harness.app, '用语音回我，我想你了', 'voice-fish-stray');
    expect(reply.res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(cues(calls[0]!.text)).toEqual(['[slightly shy]']);
  });

  it('sends plain neutral statements with no cue at all', async () => {
    harness = await createHarness({
      tts: 'ok',
      chatSupportsTools: true,
      env: { ADMIN_API_TOKEN: 'admin-test-token', MEDIA_TOOLS_ENABLED: 'true' },
      chat: { script: [['今天天气不错。']], respond: toolRoundOnce([voice()]) }
    });
    const calls: Array<{ text: string; options: TTSOptions | undefined }> = [];
    vi.spyOn(harness.app.services.capabilities, 'ttsProvider').mockReturnValue(captureProvider(calls));

    const reply = await sendText(harness.app, '用语音回我', 'voice-fish-neutral');
    expect(reply.res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe('今天天气不错。');
    expect(cues(calls[0]!.text)).toEqual([]);
  });

  it('ignores saved voice.emotions presets on the Fish path (mood table wins)', async () => {
    harness = await createHarness({
      tts: 'ok',
      chatSupportsTools: true,
      env: { ADMIN_API_TOKEN: 'admin-test-token', MEDIA_TOOLS_ENABLED: 'true' },
      chat: { script: [['哈哈，太好了！']], respond: toolRoundOnce([voice('with_text', 'happy')]) }
    });
    const saved = await harness.app.server.inject({
      method: 'PUT',
      url: '/api/admin/voice',
      headers: ADMIN,
      payload: {
        emotions: {
          neutral: { label: '中性', instructions: '保存的中性指令', speed: 0.97 },
          happy: { label: '开心', instructions: '保存的开心指令', speed: 1.23 }
        }
      }
    });
    expect(saved.statusCode).toBe(200);

    const calls: Array<{ text: string; options: TTSOptions | undefined }> = [];
    vi.spyOn(harness.app.services.capabilities, 'ttsProvider').mockReturnValue(captureProvider(calls));

    const reply = await sendText(harness.app, '用语音回我，说点开心的', 'voice-fish-preset');
    expect(reply.res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    // 1.23 is the saved preset speed; the converged Fish path must use the
    // mood table (1.02) instead — presets never override Fish.
    expect(calls[0]!.options?.speed).toBe(1.02);
    expect(cues(calls[0]!.text)).toEqual(['[warm and relaxed]']);
  });
});
