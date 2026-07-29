import { describe, expect, it } from 'vitest';
import { TtsModelSchema } from '../src/config/schema.js';
import { buildDeliveryStyle, detectSpeechEmotion, OpenAITTSProvider } from '../src/providers/tts.js';

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
