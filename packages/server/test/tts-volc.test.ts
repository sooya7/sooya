import { describe, expect, it } from 'vitest';
import { TtsModelSchema } from '../src/config/schema.js';
import { createTTSProvider, decodeVolcStream, VolcTTSProvider } from '../src/providers/tts.js';

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';

function config(overrides: Record<string, unknown> = {}) {
  return TtsModelSchema.parse({
    provider: 'volc-tts',
    baseUrl: ENDPOINT,
    apiKey: 'ark-test-key-000000000000',
    voice: 'zh_female_tianmeitaozi_uranus_bigtts',
    resourceId: 'seed-tts-2.0',
    format: 'mp3',
    ...overrides
  });
}

function mp3Chunk(): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0xc0;
  return frame;
}

/** The vendor answers with JSON lines, each carrying a base64 slice of audio. */
function stream(chunks: Buffer[], tail: Record<string, unknown> | null = null): string {
  const lines = chunks.map((c) => JSON.stringify({ reqid: 'r', code: 0, data: c.toString('base64') }));
  if (tail) lines.push(JSON.stringify(tail));
  return lines.join('\n') + '\n';
}

function capture(cfg: ReturnType<typeof config>, body: string) {
  let sent: { headers: Record<string, string>; json: Record<string, any> } | null = null;
  const provider = new VolcTTSProvider(cfg, {
    allowPrivateNetwork: true,
    fetchImpl: async (_input, init) => {
      sent = {
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        json: JSON.parse(String(init?.body))
      };
      return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
  });
  return { provider, read: () => sent };
}

describe('native 火山 TTS provider', () => {
  it('is what the factory builds for provider=volc-tts', () => {
    expect(createTTSProvider(config(), { allowPrivateNetwork: true }).name).toBe('volc-tts');
  });

  it('authenticates with the header pair the console documents, not a bearer token', async () => {
    const { provider, read } = capture(config(), stream([mp3Chunk(), mp3Chunk()]));
    await provider.synthesize('你好呀');
    const sent = read()!;
    expect(sent.headers['X-Api-Key']).toBe('ark-test-key-000000000000');
    expect(sent.headers['X-Api-Resource-Id']).toBe('seed-tts-2.0');
    expect(sent.headers['X-Api-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent.headers).not.toHaveProperty('authorization');
  });

  it('puts the text under req_params with the speaker, the way the API expects', async () => {
    const { provider, read } = capture(config(), stream([mp3Chunk()]));
    await provider.synthesize('今天好开心');
    const req = read()!.json.req_params as Record<string, unknown>;
    expect(req.speaker).toBe('zh_female_tianmeitaozi_uranus_bigtts');
    expect(req.text).toBe('今天好开心');
    expect((req.audio_params as Record<string, unknown>).format).toBe('mp3');
  });

  it('nests emotion under audio_params for a 多情感 voice, which is the only shape that works', async () => {
    const cfg = config({ voice: 'zh_female_roumeinvyou_emo_v2_mars_bigtts', emotionScale: 5 });
    const { provider, read } = capture(cfg, stream([mp3Chunk()]));
    await provider.synthesize('哈哈太好了', { emotion: 'happy' });
    const req = read()!.json.req_params as Record<string, unknown>;
    const audio = req.audio_params as Record<string, unknown>;
    expect(audio.emotion).toBe('happy');
    expect(audio.emotion_scale).toBe(5);
    // The flat field is what the hand-patched shim used, and it did nothing.
    expect(read()!.json).not.toHaveProperty('emotion');
  });

  it('sends the delivery direction through additions.context_texts, never inside the spoken text', async () => {
    const { provider, read } = capture(config(), stream([mp3Chunk()]));
    await provider.synthesize('好耶', { emotion: 'happy', instructions: '轻快、明亮、有笑意。' });
    const req = read()!.json.req_params as Record<string, unknown>;
    // Folding it into text gets it read aloud, or dropped by the parenthesis
    // filter that is on by default. Either way the direction is not delivered.
    expect(req.text).toBe('好耶');
    expect(JSON.parse(String(req.additions))).toEqual({ context_texts: ['轻快、明亮、有笑意。'] });
    expect(req.audio_params).not.toHaveProperty('emotion');
  });

  it('omits a model field from req_params even when configured, since the vendor selects the model via X-Api-Resource-Id', async () => {
    const { provider, read } = capture(config({ model: 'seed-tts-2.0' }), stream([mp3Chunk()]));
    await provider.synthesize('测试');
    expect(read()!.json.req_params).not.toHaveProperty('model');
  });

  it('serialises additions as a JSON string, because a raw object panics the vendor behind a 200', async () => {
    const { provider, read } = capture(config(), stream([mp3Chunk()]));
    await provider.synthesize('好耶', { instructions: '慢一点。' });
    expect(typeof read()!.json.req_params.additions).toBe('string');
  });

  it('omits additions entirely when there is no direction to give', async () => {
    const { provider, read } = capture(config(), stream([mp3Chunk()]));
    await provider.synthesize('好耶');
    expect(read()!.json.req_params).not.toHaveProperty('additions');
  });

  it('translates opus to the ogg_opus spelling the vendor uses', async () => {
    const { provider, read } = capture(config({ format: 'opus' }), stream([mp3Chunk()]));
    await provider.synthesize('测试');
    expect((read()!.json.req_params as Record<string, unknown>).audio_params).toMatchObject({ format: 'ogg_opus' });
  });
});

describe('decoding the JSON-lines audio stream', () => {
  it('joins every chunk instead of stopping at the first line', () => {
    const joined = decodeVolcStream(stream([mp3Chunk(), mp3Chunk(), mp3Chunk()]));
    expect(joined.byteLength).toBe(417 * 3);
  });

  it('fails on an error reported after audio has already started', () => {
    const body = stream([mp3Chunk()], { reqid: 'r', code: 45_000_010, message: 'Invalid X-Api-Key' });
    expect(() => decodeVolcStream(body)).toThrow(/45000010|Invalid X-Api-Key/);
  });

  it('tolerates SSE style data: prefixes and blank lines', () => {
    const body = `\ndata: ${JSON.stringify({ code: 0, data: mp3Chunk().toString('base64') })}\n\n`;
    expect(decodeVolcStream(body).byteLength).toBe(417);
  });

  it('refuses a reply that carries no audio at all', () => {
    expect(() => decodeVolcStream('')).toThrow(/empty stream/);
    expect(() => decodeVolcStream(JSON.stringify({ code: 0, message: 'ok' }))).toThrow(/no audio/);
    expect(() => decodeVolcStream('not json at all')).toThrow(/non-JSON/);
  });
});
