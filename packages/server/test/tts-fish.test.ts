import { describe, expect, it, vi } from 'vitest';
import { TtsModelSchema } from '../src/config/schema.js';
import { createTTSProvider, FishAudioProvider } from '../src/providers/tts.js';
import {
  cueIntensityBand,
  fishCueFor,
  fishCueForMood,
  renderFishSynthesisTextForMood,
  fishSpeedForMood
} from '../src/core/voice/fishCue.js';

const ENDPOINT = 'https://api.fish.audio/v1/tts';

function config(overrides: Record<string, unknown> = {}) {
  return TtsModelSchema.parse({
    provider: 'fish',
    baseUrl: ENDPOINT,
    apiKey: 'fish-test-key-000000000000',
    model: 's2.1-pro-free',
    referenceId: 'sooya-voice-01',
    format: 'mp3',
    ...overrides
  });
}

/** A byte string long enough to pass the small-payload guard. */
function fakeMp3(): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0xc0;
  return Buffer.concat(Array.from({ length: 4 }, () => frame));
}

function capture(cfg: ReturnType<typeof config>, response: () => Response) {
  let sent: { headers: Record<string, string>; json: Record<string, unknown>; url: string } | null = null;
  const provider = new FishAudioProvider(cfg, {
    allowPrivateNetwork: true,
    fetchImpl: async (input, init) => {
      sent = {
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        json: JSON.parse(String(init?.body)),
        url: String(input)
      };
      return response();
    }
  });
  return { provider, read: () => sent };
}

describe('FishAudioProvider', () => {
  it('is what the factory builds for provider=fish', () => {
    expect(createTTSProvider(config(), { allowPrivateNetwork: true }).name).toBe('fish');
  });

  it('is configured only when key and model are present (reference id optional)', () => {
    expect(new FishAudioProvider(config(), { allowPrivateNetwork: true }).configured).toBe(true);
    expect(new FishAudioProvider(config({ apiKey: '' }), { allowPrivateNetwork: true }).configured).toBe(false);
    expect(new FishAudioProvider(config({ referenceId: '' }), { allowPrivateNetwork: true }).configured).toBe(true);
  });

  it('posts the Fish /v1/tts contract with the model in the HTTP header', async () => {
    const { provider, read } = capture(config(), () => new Response(fakeMp3(), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    // The thin provider ships the upstream FINAL text/speed verbatim — no
    // second cue compile, no mood re-detection (convergence §9).
    await provider.synthesize('[small chuckle] 你怎么这么会说啊，行吧算你赢', { speed: 0.97, emotion: 'playful' });
    const sent = read()!;

    expect(sent.url).toBe(ENDPOINT);
    expect(sent.headers.authorization).toBe('Bearer fish-test-key-000000000000');
    // The free tier is selected through the model HEADER, never the JSON body:
    // a model in the body makes Fish bill the paid model and answer 402.
    expect(sent.headers.model).toBe('s2.1-pro-free');
    expect(sent.json.model).toBeUndefined();
    expect(sent.json).toMatchObject({
      reference_id: 'sooya-voice-01',
      temperature: 0.65,
      top_p: 0.7,
      prosody: { speed: 0.97, volume: 0, normalize_loudness: true },
      chunk_length: 200,
      normalize: true,
      format: 'mp3',
      sample_rate: 44_100,
      mp3_bitrate: 128,
      latency: 'balanced',
      repetition_penalty: 1.2,
      condition_on_previous_chunks: true
    });
    // The provider never touches the text it was given.
    expect(sent.json.text).toBe('[small chuckle] 你怎么这么会说啊，行吧算你赢');
  });

  it('omits reference_id from the body when none is configured', async () => {
    const { provider, read } = capture(config({ referenceId: '' }), () => new Response(fakeMp3(), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    await provider.synthesize('今天天气不错');
    expect(read()!.json.reference_id).toBeUndefined();
    expect(read()!.headers.model).toBe('s2.1-pro-free');
  });

  it('falls back to the shared voice field as the Fish voice id', async () => {
    const { provider, read } = capture(config({ referenceId: '', voice: 'f729a143b9a34005bdae0b21697fa41a' }), () => new Response(fakeMp3(), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    await provider.synthesize('今天天气不错');
    expect(read()!.json.reference_id).toBe('f729a143b9a34005bdae0b21697fa41a');
  });

  it('never sends the OpenAI default alloy as a Fish voice id', async () => {
    const { provider, read } = capture(config({ referenceId: '', voice: 'alloy' }), () => new Response(fakeMp3(), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    await provider.synthesize('今天天气不错');
    expect(read()!.json.reference_id).toBeUndefined();
  });

  it('uses the configured global speed when no final speed is passed', async () => {
    const { provider, read } = capture(config({ speed: 1.05 }), () => new Response(fakeMp3(), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    await provider.synthesize('今天天气不错');
    expect(read()!.json.prosody.speed).toBe(1.05);
  });

  it('clamps an out-of-range upstream speed into 0.8–1.2', async () => {
    const { provider, read } = capture(config(), () => new Response(fakeMp3(), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    await provider.synthesize('今天天气不错', { speed: 0.3 });
    expect(read()!.json.prosody.speed).toBe(0.8);
    await provider.synthesize('今天天气不错', { speed: 3 });
    expect(read()!.json.prosody.speed).toBe(1.2);
  });

  it('never retries 4xx parameter errors', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const provider = new FishAudioProvider(config({ maxRetries: 3 }), { allowPrivateNetwork: true, fetchImpl });
    await expect(provider.synthesize('你好')).rejects.toThrow(/status 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 429 once then surfaces the failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(fakeMp3(), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const provider = new FishAudioProvider(config({ maxRetries: 1 }), { allowPrivateNetwork: true, fetchImpl });
    const audio = await provider.synthesize('你好');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(audio.format).toBe('mp3');
  });

  it('does not retry timeouts', async () => {
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const fail = () => reject(init?.signal?.reason ?? new Error('aborted'));
      if (init?.signal?.aborted) { fail(); return; }
      init?.signal?.addEventListener('abort', fail, { once: true });
      const timer = setTimeout(() => resolve(new Response(fakeMp3(), { status: 200 })), 5000);
      init?.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
    }));
    const provider = new FishAudioProvider(config({ maxRetries: 2, timeoutMs: 1000 }), { allowPrivateNetwork: true, fetchImpl });
    await expect(provider.synthesize('你好')).rejects.toThrow(/timed out/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts the in-flight request when the upstream signal fires', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const fail = () => reject(init?.signal?.reason ?? new Error('aborted'));
      if (init?.signal?.aborted) { fail(); return; }
      init?.signal?.addEventListener('abort', fail, { once: true });
      const timer = setTimeout(() => resolve(new Response(fakeMp3(), { status: 200 })), 5000);
      init?.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
    }));
    const provider = new FishAudioProvider(config(), { allowPrivateNetwork: true, fetchImpl });
    const promise = provider.synthesize('你好', { signal: controller.signal });
    controller.abort(new Error('user interrupted'));
    await expect(promise).rejects.toThrow('user interrupted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('inspectHealth reports the configured reference and model', async () => {
    const health = await new FishAudioProvider(config(), { allowPrivateNetwork: true }).inspectHealth();
    expect(health).toMatchObject({ capability: 'tts', configured: true, provider: 'fish', model: 's2.1-pro-free' });
  });
});

describe('FishCueRenderer whitelist', () => {
  it('maps the domain emotions onto the doc cue table only', () => {
    expect(fishCueForMood('playful', { intensity: 1 }).cue).toBe('[small chuckle]');
    expect(fishCueForMood('gentle', { intensity: 1 }).cue).toBe('[speaking softly]');
    expect(fishCueForMood('serious', { intensity: 1 }).cue).toBeNull();
    expect(fishCueForMood('happy', { intensity: 1 }).cue).toBe('[warm and relaxed]');
    // Doc §5 has no cue for these moods: silence, never a guess.
    expect(fishCueForMood('sad', { intensity: 1 }).cue).toBeNull();
    expect(fishCueForMood('angry', { intensity: 1 }).cue).toBeNull();
    expect(fishCueForMood('sleepy', { intensity: 1 }).cue).toBe('[slightly sleepy]');
    // Unknown moods map to no cue.
    expect(fishCueForMood('dramatic', { intensity: 1 }).cue).toBeNull();
  });

  it('suppresses the cue entirely at intensity 0', () => {
    expect(fishCueForMood('playful', { intensity: 0 }).cue).toBeNull();
    expect(fishCueForMood('happy', { intensity: 0 }).cue).toBeNull();
  });

  it('never emits the banned over-the-top tags', () => {
    const rendered = renderFishSynthesisTextForMood('我想你', 'reassuring', { intensity: 1 });
    expect(rendered).not.toMatch(/laughing|sobbing|shouting|screaming|panting/);
  });

  it('prepends the cue but never rewrites the transcript', () => {
    expect(renderFishSynthesisTextForMood('（轻笑）你真会说话', 'playful', { intensity: 1 })).toBe('[small chuckle] （轻笑）你真会说话');
    expect(renderFishSynthesisTextForMood('晚安，做个好梦', 'gentle', { intensity: 1 })).toBe('[speaking softly] 晚安，做个好梦');
    expect(renderFishSynthesisTextForMood('晚安，做个好梦', 'neutral', { intensity: 1 })).toBe('晚安，做个好梦');
  });

  it('keeps speeds inside the doc 0.94–1.04 range', () => {
    for (const mood of ['neutral', 'happy', 'gentle', 'sad', 'angry', 'sleepy', 'playful', 'serious']) {
      const speed = fishCueForMood(mood, { intensity: 1 }).speed;
      expect(speed).toBeGreaterThanOrEqual(0.94);
      expect(speed).toBeLessThanOrEqual(1.05);
    }
  });

  it('bridges the doc ten-mood aliases without renaming the domain enum', () => {
    expect(fishCueFor({ primaryEmotion: 'happy', pace: 1, energy: 0.7, warmth: 0.7, intimacy: 0.6, seriousness: 0.25, openingStyle: 'smiling', endingStyle: 'playful', pauseStyle: 'natural', emphasis: [], instructions: '' }, { intensity: 1, moodAlias: 'warm' }).cue).toBe('[warm and relaxed]');
    expect(fishCueForMood('gentle', { intensity: 1, moodAlias: 'concerned' }).cue).toBeNull();
  });

  it('maps continuous 0–1 intensity onto the three bands (convergence §7.2)', () => {
    expect(cueIntensityBand(0)).toBe('none');
    expect(cueIntensityBand(0.3)).toBe('none');
    expect(cueIntensityBand(0.31)).toBe('light');
    expect(cueIntensityBand(0.6)).toBe('light');
    expect(cueIntensityBand(0.61)).toBe('full');
    expect(cueIntensityBand(1)).toBe('full');
  });

  it('adds no cue for low intensity and for plain neutral statements', () => {
    expect(fishCueForMood('shy', { intensity: 0.2, moodAlias: 'shy' }).cue).toBeNull();
    expect(fishCueForMood('playful', { intensity: 0 }).cue).toBeNull();
    expect(fishCueForMood('neutral', { intensity: 1 }).cue).toBeNull();
  });

  it('light intensity keeps the mood cue but blends the pace toward neutral', () => {
    expect(fishCueForMood('shy', { intensity: 0.5, moodAlias: 'shy' })).toEqual({ cue: '[slightly shy]', speed: 0.99 });
    expect(fishCueForMood('sleepy', { intensity: 0.5 })).toEqual({ cue: '[slightly sleepy]', speed: 0.98 });
    expect(fishCueForMood('happy', { intensity: 0.5 })).toEqual({ cue: '[warm and relaxed]', speed: 1.01 });
  });

  it('full intensity uses the mood table pace as-is', () => {
    expect(fishCueForMood('happy', { intensity: 0.8 })).toEqual({ cue: '[warm and relaxed]', speed: 1.02 });
    expect(fishCueForMood('gentle', { intensity: 1 })).toEqual({ cue: '[speaking softly]', speed: 0.97 });
  });

  it('speed priority is director → mood → TTS default (convergence §7.3)', () => {
    // Director wins even over the mood pace.
    expect(fishCueForMood('happy', { intensity: 1, directorSpeed: 0.95 })).toEqual({ cue: '[warm and relaxed]', speed: 0.95 });
    expect(fishCueForMood('neutral', { intensity: 1, directorSpeed: 1.03 })).toEqual({ cue: null, speed: 1.03 });
    // Mood pace beats the global default.
    expect(fishCueForMood('gentle', { intensity: 1, fallbackSpeed: 1.1 }).speed).toBe(0.97);
    expect(fishCueForMood('neutral', { intensity: 0, fallbackSpeed: 1.1 }).speed).toBe(1);
    // The global default is the last resort for moods outside the table,
    // still clamped to the 0.94–1.05 range.
    expect(fishCueForMood('dramatic', { intensity: 0, fallbackSpeed: 1.1 }).speed).toBe(1.05);
    expect(fishCueForMood('dramatic', { intensity: 0, fallbackSpeed: 0.9 }).speed).toBe(0.94);
    expect(fishCueForMood('dramatic', { intensity: 0, fallbackSpeed: 1.03 }).speed).toBe(1.03);
  });

  it('the alias cue is reachable with a raw emotion string ([[voice:emotion=shy]])', () => {
    expect(fishSpeedForMood('shy', { intensity: 1, moodAlias: 'shy' })).toBe(0.98);
    expect(renderFishSynthesisTextForMood('我其实有点想你', 'shy', { intensity: 0.6, moodAlias: 'shy' })).toBe('[slightly shy] 我其实有点想你');
    expect(renderFishSynthesisTextForMood('我其实有点想你', 'shy', { intensity: 0.2, moodAlias: 'shy' })).toBe('我其实有点想你');
  });
});
