import type { TtsModelConfig } from '../config/schema.js';
import { assertSafeUrl, withRetry, HttpTimeoutError } from '../util/http.js';
import { probeAudioDuration } from '../util/audio.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type HealthStatus,
  type SynthesizedAudio,
  type TTSOptions,
  type TTSProvider
} from './types.js';
import { normalizeAbort, safeText, type ProviderDeps } from './chat/openai.js';

const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac'
};

type Emotion = 'warm' | 'comforting' | 'happy' | 'playful' | 'sad' | 'angry' | 'sleepy' | 'serious' | 'curious' | 'neutral';

interface DeliveryStyle {
  emotion: Emotion;
  instructions: string;
  speed: number;
  text: string;
}

const EMOTION_RULES: Array<{ emotion: Emotion; re: RegExp }> = [
  { emotion: 'comforting', re: /抱抱|别难过|没事的|辛苦了|我陪你|会好的|慢慢来|不要怕/ },
  { emotion: 'sad', re: /难过|伤心|委屈|想哭|舍不得|遗憾|对不起/ },
  { emotion: 'angry', re: /生气|气死|讨厌|烦死|太过分|不许|别这样/ },
  { emotion: 'sleepy', re: /晚安|睡吧|困了|做个好梦|休息吧/ },
  { emotion: 'playful', re: /嘿嘿|哼哼|笨蛋|逗你|才不要|好不好嘛|求求|撒娇/ },
  { emotion: 'happy', re: /哈哈|开心|好耶|太好了|恭喜|喜欢|真棒|耶[！!]?/ },
  { emotion: 'curious', re: /为什么|怎么会|真的吗|是吗|呢[？?]|[？?]$/ },
  { emotion: 'serious', re: /认真|重要|必须|需要注意|先别急|听我说/ },
  { emotion: 'warm', re: /想你|在乎|喜欢你|陪着你|谢谢你|一直都在/ }
];

const DELIVERY: Record<Emotion, { instruction: string; speed: number }> = {
  warm: { instruction: '用亲近、温柔、自然的聊天语气说，声音里带一点笑意和关心，不要像播报。', speed: 0.96 },
  comforting: { instruction: '用安慰人的温柔语气说，语速稍慢，停顿自然，声音柔和且可靠，不要夸张表演。', speed: 0.9 },
  happy: { instruction: '用轻快、开心、有活力的语气说，带一点自然笑意，节奏灵动但不要喊叫。', speed: 1.06 },
  playful: { instruction: '用熟人之间俏皮、带一点撒娇和调侃的语气说，句尾自然，避免机械朗读。', speed: 1.02 },
  sad: { instruction: '用低一点、克制而真诚的语气说，语速稍慢，保留轻微停顿，不要戏剧化。', speed: 0.9 },
  angry: { instruction: '用有情绪但克制的语气说，重音清楚，略快一点，不要吼叫或攻击性过强。', speed: 1.04 },
  sleepy: { instruction: '用很轻、柔软、接近睡前耳语的语气说，语速慢一点，停顿舒缓。', speed: 0.86 },
  serious: { instruction: '用认真、清楚、沉稳的语气说，重点词稍加重音，不要像新闻播音。', speed: 0.96 },
  curious: { instruction: '用自然好奇、带一点上扬语调的聊天语气说，避免平直朗读。', speed: 1 },
  neutral: { instruction: '用自然、亲近、像真人聊天一样的语气说，避免播音腔、客服腔和机械朗读。', speed: 1 }
};

export class OpenAITTSProvider implements TTSProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: TtsModelConfig,
    private readonly deps: ProviderDeps
  ) {
    this.name = cfg.provider;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.cfg.provider !== 'none' && !!this.cfg.baseUrl && !!this.cfg.model && !!this.cfg.apiKey;
  }

  private endpoint(): string {
    const b = this.cfg.baseUrl.replace(/\/+$/, '');
    return b.endsWith('/audio/speech') ? b : `${b}/audio/speech`;
  }

  async synthesize(text: string, opts: TTSOptions = {}): Promise<SynthesizedAudio> {
    if (!this.configured) throw new ProviderNotConfiguredError('tts');
    const trimmed = text.trim();
    if (!trimmed) throw new ProviderRequestError('tts requires non-empty text');

    const delivery = this.cfg.expressive ? buildDeliveryStyle(trimmed, this.cfg.speed, this.cfg.emotionIntensity) : null;
    const spokenText = delivery?.text ?? trimmed;
    const speed = clamp(opts.speed ?? delivery?.speed ?? this.cfg.speed, 0.25, 4);
    const instructions = opts.instructions ?? delivery?.instructions;

    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new HttpTimeoutError(`tts timed out after ${this.cfg.timeoutMs}ms`)),
          this.cfg.timeoutMs
        );
        const onAbort = () => controller.abort(opts.signal?.reason);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
          const body: Record<string, unknown> = {
            model: this.cfg.model,
            input: spokenText,
            voice: opts.voice ?? this.cfg.voice,
            response_format: this.cfg.format,
            speed
          };
          if (instructions && shouldSendInstructions(this.cfg)) body.instructions = instructions;

          const res = await this.fetchImpl(this.endpoint(), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal
          });
          if (!res.ok) throw new ProviderRequestError(`tts failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const data = Buffer.from(await res.arrayBuffer());
          if (data.byteLength < 128) throw new ProviderRequestError(`tts returned suspiciously small payload (${data.byteLength} bytes)`);
          rejectTextPayload(data, res.headers.get('content-type'));
          const mime = res.headers.get('content-type')?.split(';')[0] ?? FORMAT_MIME[this.cfg.format] ?? 'application/octet-stream';
          const durationSec = probeAudioDuration(data, mime) ?? undefined;
          return { data, mime, format: this.cfg.format, durationSec };
        } catch (err) {
          throw normalizeAbort(err, this.cfg.timeoutMs);
        } finally {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
        }
      },
      { retries: this.cfg.maxRetries }
    );
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'tts',
      configured: this.configured,
      ok: this.configured,
      provider: this.cfg.provider,
      model: this.cfg.model || undefined,
      detail: this.configured
        ? `configured (voice=${this.cfg.voice}, format=${this.cfg.format}, expressive=${this.cfg.expressive}, instructions=${this.cfg.instructionMode})`
        : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export class UnconfiguredTTSProvider implements TTSProvider {
  readonly name = 'none';
  readonly configured = false;
  async synthesize(): Promise<SynthesizedAudio> {
    throw new ProviderNotConfiguredError('tts');
  }
  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'tts',
      configured: false,
      ok: false,
      provider: 'none',
      detail: 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export function createTTSProvider(cfg: TtsModelConfig, deps: ProviderDeps): TTSProvider {
  if (cfg.provider === 'none') return new UnconfiguredTTSProvider();
  return new OpenAITTSProvider(cfg, deps);
}

export function detectSpeechEmotion(text: string): Emotion {
  for (const rule of EMOTION_RULES) {
    if (rule.re.test(text)) return rule.emotion;
  }
  return 'neutral';
}

export function buildDeliveryStyle(text: string, baseSpeed = 1, intensity = 0.75): DeliveryStyle {
  const emotion = detectSpeechEmotion(text);
  const preset = DELIVERY[emotion];
  const amount = clamp(intensity, 0, 1);
  const speed = clamp(baseSpeed + (preset.speed - 1) * amount, 0.25, 4);
  const strength = amount >= 0.7 ? '明显但自然地' : amount >= 0.35 ? '适度地' : '轻微地';
  const instructions = `${strength}${preset.instruction}`;
  return { emotion, instructions, speed, text: makeSpeechFriendly(text, emotion) };
}

function makeSpeechFriendly(text: string, emotion: Emotion): string {
  let out = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // TTS engines generally honour punctuation better than prose-only style hints.
  // Add restrained pauses without changing the words or the visible transcript.
  out = out.replace(/([，。！？!?])\s*/g, '$1 ');
  if (emotion === 'comforting' || emotion === 'sad' || emotion === 'sleepy') {
    out = out.replace(/([。！？!?])\s+/g, '$1 … ');
  }
  return out.trim();
}

function shouldSendInstructions(cfg: TtsModelConfig): boolean {
  if (cfg.instructionMode === 'on') return true;
  if (cfg.instructionMode === 'off') return false;
  return /gpt[-_.]?4o.*tts|mini[-_.]?tts|speech.*instruction/i.test(cfg.model);
}

function rejectTextPayload(data: Buffer, contentType: string | null): void {
  const mime = (contentType ?? '').toLowerCase();
  const sample = data.subarray(0, Math.min(data.length, 256)).toString('utf8').trimStart();
  const looksText = mime.includes('json') || mime.startsWith('text/') || sample.startsWith('{') || sample.startsWith('[');
  if (looksText) {
    throw new ProviderRequestError('tts returned JSON/text instead of playable audio');
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
