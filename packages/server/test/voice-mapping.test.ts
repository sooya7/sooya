import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TTSOptions, TTSProvider } from '../src/providers/types.js';
import { resolveVoiceDelivery, type VoiceEmotionMap } from '../src/core/voice.js';
import { createHarness, makeFakeMp3, sendText, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (harness) await harness.cleanup();
  harness = null;
});

const ADMIN = { 'x-admin-token': 'admin-test-token' };

describe('saved voice emotion mappings', () => {
  it('maps detected provider emotions onto saved UI presets and falls back consistently', () => {
    const saved: VoiceEmotionMap = {
      neutral: { label: '中性', instructions: '保存的中性指令', speed: 0.97 },
      gentle: { label: '温柔', instructions: '保存的温柔指令', speed: 0.88 }
    };

    expect(resolveVoiceDelivery('别难过，我会陪着你。', null, saved)).toEqual({
      emotion: 'gentle',
      instructions: '保存的温柔指令',
      speed: 0.88
    });
    expect(resolveVoiceDelivery('哈哈，太好了！', null, saved)).toEqual({
      emotion: 'neutral',
      instructions: '保存的中性指令',
      speed: 0.97
    });
    expect(resolveVoiceDelivery('任意文本', 'missing-preset', saved)).toEqual({
      emotion: 'neutral',
      instructions: '保存的中性指令',
      speed: 0.97
    });
  });

  it('uses the same saved mapping for preview and formal assistant speech', async () => {
    harness = await createHarness({
      tts: 'ok',
      env: { ADMIN_API_TOKEN: 'admin-test-token' },
      chat: { script: [['哈哈，太好了！[[voice]]']] }
    });
    const calls: Array<{ text: string; options: TTSOptions | undefined }> = [];
    const provider: TTSProvider = {
      name: 'capturing-tts',
      configured: true,
      synthesize: async (text, options) => {
        calls.push({ text, options });
        return { data: makeFakeMp3(), mime: 'audio/mpeg', format: 'mp3', durationSec: 1 };
      },
      inspectHealth: async () => ({ capability: 'tts', configured: true, ok: true })
    };
    vi.spyOn(harness.app.services.capabilities, 'ttsProvider').mockReturnValue(provider);

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

    const preview = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/voice/preview',
      headers: ADMIN,
      payload: { text: '试听开心语气', emotion: 'happy' }
    });
    expect(preview.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({
      text: '试听开心语气',
      options: { emotion: 'happy', instructions: '保存的开心指令', speed: 1.23 }
    });

    const reply = await sendText(harness.app, '说点开心的', 'voice-mapping-formal');
    expect(reply.res.statusCode).toBe(200);
    expect(calls[1]).toMatchObject({
      text: '哈哈，太好了！',
      options: { emotion: 'happy', instructions: '保存的开心指令', speed: 1.23 }
    });
    expect(reply.body.reply.status).toBe('sent');
    const audio = (reply.body.reply.content as Array<{
      type: string;
      status: string;
      mediaId?: string;
      transcript?: string;
    }>).find((part) => part.type === 'audio');
    expect(audio).toMatchObject({
      type: 'audio',
      status: 'sent',
      transcript: '哈哈，太好了！'
    });
    expect(audio?.mediaId).toBeTruthy();
    const stored = harness.app.repos.messages.get(reply.body.reply.id);
    expect(stored?.content.find((part) => part.type === 'audio')).toMatchObject({
      status: 'sent',
      mediaId: audio?.mediaId
    });

    const unknownPreview = await harness.app.server.inject({
      method: 'POST',
      url: '/api/admin/voice/preview',
      headers: ADMIN,
      payload: { text: '未知情绪', emotion: 'not-configured' }
    });
    expect(unknownPreview.statusCode).toBe(200);
    expect(calls[2]?.options).toMatchObject({
      emotion: 'neutral',
      instructions: '保存的中性指令',
      speed: 0.97
    });
  });
});
