import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TTSOptions, TTSProvider } from '../src/providers/types.js';
import { createHarness, makeFakeMp3, sendText, type Harness } from './helpers/harness.js';

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
  it('ships director text with at most one whitelist cue and the director speed', async () => {
    harness = await createHarness({
      tts: 'ok',
      env: { ADMIN_API_TOKEN: 'admin-test-token' },
      chat: { script: [
        // Explicit user voice request → replace mode; the model marker carries
        // the real emotion + intensity from the main model.
        ['我刚刚有点想你。[[voice:emotion=shy|intensity=0.6]]'],
        ['{"text":"我刚刚有点想你。","speed":0.96}'],
        ['我刚刚有点想你。']
      ] }
    });
    const calls: Array<{ text: string; options: TTSOptions | undefined }> = [];
    vi.spyOn(harness.app.services.capabilities, 'ttsProvider').mockReturnValue(captureProvider(calls));

    const reply = await sendText(harness.app, '用语音回我，我想你了', 'voice-fish-shy');
    expect(reply.res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    // Exactly one cue — the FishCueRenderer's, never a second one on top.
    expect(cues(calls[0]!.text)).toEqual(['[slightly shy]']);
    expect(calls[0]!.text).toBe('[slightly shy] 我刚刚有点想你。');
    // The Voice Director's speed wins the priority chain.
    expect(calls[0]!.options?.speed).toBe(0.96);
  });

  it('strips a stray cue from the director so the request still carries exactly one', async () => {
    harness = await createHarness({
      tts: 'ok',
      env: { ADMIN_API_TOKEN: 'admin-test-token' },
      chat: { script: [
        ['我刚刚有点想你。[[voice:emotion=shy|intensity=0.9]]'],
        // The model drifted and emitted its own cue; sanitizeFishText removes
        // it wholesale, then FishCueRenderer adds exactly one.
        ['{"text":"[small chuckle] 我刚刚有点想你。","speed":0.96}'],
        ['我刚刚有点想你。']
      ] }
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
      env: { ADMIN_API_TOKEN: 'admin-test-token' },
      chat: { script: [
        ['今天天气不错。[[voice]]'],
        ['{"text":"今天天气不错。","speed":1}'],
        ['今天天气不错。']
      ] }
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
      env: { ADMIN_API_TOKEN: 'admin-test-token' },
      chat: { script: [
        ['哈哈，太好了！[[voice:emotion=happy]]'],
        ['{"text":"哈哈，太好了！","speed":1}'],
        ['哈哈，太好了！']
      ] }
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
