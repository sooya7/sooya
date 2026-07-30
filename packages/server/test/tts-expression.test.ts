import { describe, expect, it } from 'vitest';
import { TtsModelSchema } from '../src/config/schema.js';
import {
  buildDeliveryStyle,
  detectSpeechEmotion,
  officialEmotion,
  OpenAITTSProvider,
  resolveEmotionTransport
} from '../src/providers/tts.js';

function fakeMp3(): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0xc0;
  return Buffer.concat(Array.from({ length: 4 }, () => frame));
}

function config(overrides: Record<string, unknown> = {}) {
  return TtsModelSchema.parse({
    provider: 'openai-tts',
    baseUrl: 'https://tts.example.com/v1',
    apiKey: 'sk-test-tts-key-000000',
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    expressive: true,
    instructionMode: 'on',
    emotionIntensity: 0.8,
    ...overrides
  });
}

describe('emotion-aware TTS', () => {
  it('recognises common conversational emotions', () => {
    expect(detectSpeechEmotion('别难过，我会一直陪着你。')).toBe('comforting');
    expect(detectSpeechEmotion('哈哈太好了！')).toBe('happy');
    expect(detectSpeechEmotion('晚安，做个好梦。')).toBe('sleepy');
    expect(detectSpeechEmotion('真的吗？')).toBe('curious');
  });

  it('changes pacing and produces a natural delivery instruction', () => {
    const comforting = buildDeliveryStyle('没事的，慢慢来。', 1, 0.8);
    const happy = buildDeliveryStyle('哈哈，好耶！', 1, 0.8);

    expect(comforting.emotion).toBe('comforting');
    expect(comforting.speed).toBeLessThan(1);
    expect(comforting.instructions).toContain('安慰');
    expect(comforting.text).toContain('…');

    expect(happy.emotion).toBe('happy');
    expect(happy.speed).toBeGreaterThan(1);
    expect(happy.instructions).toContain('开心');
  });

  it('sends instructions and emotion-adjusted speed to instruction-capable TTS', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const provider = new OpenAITTSProvider(config(), {
      allowPrivateNetwork: true,
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(new Uint8Array(fakeMp3()), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' }
        });
      }
    });

    await provider.synthesize('别难过，我陪着你。');

    expect(requestBody?.instructions).toContain('安慰');
    expect(Number(requestBody?.speed)).toBeLessThan(1);
    expect(String(requestBody?.input)).toContain('…');
  });

  it('can omit instructions for strict compatible gateways', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const provider = new OpenAITTSProvider(config({ instructionMode: 'off' }), {
      allowPrivateNetwork: true,
      fetchImpl: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(new Uint8Array(fakeMp3()), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' }
        });
      }
    });

    await provider.synthesize('晚安，睡个好觉。');
    expect(requestBody).not.toHaveProperty('instructions');
    expect(Number(requestBody?.speed)).toBeLessThan(1);
  });

  it('rejects JSON or NDJSON text masquerading as audio', async () => {
    const ndjson = `${JSON.stringify({ data: 'AAAA' })}\n${JSON.stringify({ data: 'BBBB' })}\n`.repeat(8);
    const provider = new OpenAITTSProvider(config(), {
      allowPrivateNetwork: true,
      fetchImpl: async () => new Response(ndjson, { status: 200, headers: { 'content-type': 'application/json' } })
    });

    await expect(provider.synthesize('测试语音')).rejects.toThrow(/JSON\/text instead of playable audio/);
  });
});

describe('emotion transport picks the channel the voice can hear', () => {
  const at = (overrides: Record<string, unknown>) => {
    const cfg = config(overrides);
    return resolveEmotionTransport(cfg, String(overrides.voice ?? cfg.voice));
  };

  it('reads the voice id under auto, because the vendor publishes it there', () => {
    // 多情感音色 carry the enum; 2.0 音色 are instruction-following.
    expect(at({ voice: 'zh_female_roumeinvyou_emo_v2_mars_bigtts' })).toBe('enum');
    expect(at({ voice: 'zh_male_guangzhoudege_emo_mars_bigtts' })).toBe('enum');
    expect(at({ voice: 'zh_female_tianmeitaozi_uranus_bigtts' })).toBe('instruction');
    expect(at({ voice: 'alloy' })).toBe('instruction');
  });

  it('lets an explicit mode override the guess in both directions', () => {
    expect(at({ voice: 'zh_female_tianmeitaozi_uranus_bigtts', emotionMode: 'enum' })).toBe('enum');
    expect(at({ voice: 'zh_female_roumeinvyou_emo_v2_mars_bigtts', emotionMode: 'instruction' })).toBe('instruction');
    expect(at({ voice: 'zh_female_roumeinvyou_emo_v2_mars_bigtts', emotionMode: 'off' })).toBe('off');
  });

  it('stays silent when expression is switched off entirely', () => {
    expect(at({ emotionMode: 'enum', expressive: false })).toBe('off');
  });

  it('drops emotion words the 多情感 voices do not define, instead of guessing', () => {
    expect(officialEmotion('happy')).toBe('happy');
    expect(officialEmotion('SAD')).toBe('sad');
    // `gentle` is one of ours, with no vendor equivalent — it must not be sent.
    expect(officialEmotion('gentle')).toBeNull();
    expect(officialEmotion('撒娇')).toBeNull();
    expect(officialEmotion(undefined)).toBeNull();
  });

  it('sends the enum pair and no instructions for a 多情感 voice', async () => {
    let body: Record<string, unknown> | null = null;
    const provider = new OpenAITTSProvider(
      config({ voice: 'zh_female_roumeinvyou_emo_v2_mars_bigtts', emotionScale: 5 }),
      {
        allowPrivateNetwork: true,
        fetchImpl: async (_i, init) => {
          body = JSON.parse(String(init?.body));
          return new Response(new Uint8Array(fakeMp3()), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
        }
      }
    );

    await provider.synthesize('哈哈太好了！', { emotion: 'happy' });

    expect(body?.emotion).toBe('happy');
    expect(body?.emotion_scale).toBe(5);
    expect(body).not.toHaveProperty('instructions');
  });

  it('sends instructions and no enum pair for an instruction-following voice', async () => {
    let body: Record<string, unknown> | null = null;
    const provider = new OpenAITTSProvider(config({ voice: 'zh_female_tianmeitaozi_uranus_bigtts' }), {
      allowPrivateNetwork: true,
      fetchImpl: async (_i, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(new Uint8Array(fakeMp3()), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
    });

    await provider.synthesize('哈哈太好了！', { emotion: 'happy', instructions: '轻快、明亮、有笑意。' });

    expect(String(body?.instructions)).toContain('轻快');
    expect(body).not.toHaveProperty('emotion');
    expect(body).not.toHaveProperty('emotion_scale');
  });

  it('omits the enum pair when the mood has no vendor word, rather than sending gentle', async () => {
    let body: Record<string, unknown> | null = null;
    const provider = new OpenAITTSProvider(config({ voice: 'zh_female_roumeinvyou_emo_v2_mars_bigtts' }), {
      allowPrivateNetwork: true,
      fetchImpl: async (_i, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(new Uint8Array(fakeMp3()), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
    });

    await provider.synthesize('慢慢来，我在。', { emotion: 'gentle' });

    expect(body).not.toHaveProperty('emotion');
    expect(body).not.toHaveProperty('emotion_scale');
  });
});
