import type { TtsModelConfig } from '../config/schema.js';
import { assertSafeUrl, withRetry, HttpTimeoutError } from '../util/http.js';
import { probeAudioDuration } from '../util/audio.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type HealthStatus,
  type SynthesizedAudio,
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

  async synthesize(text: string, opts: { voice?: string; signal?: AbortSignal } = {}): Promise<SynthesizedAudio> {
    if (!this.configured) throw new ProviderNotConfiguredError('tts');
    const trimmed = text.trim();
    if (!trimmed) throw new ProviderRequestError('tts requires non-empty text');
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
          const res = await this.fetchImpl(this.endpoint(), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
            body: JSON.stringify({
              model: this.cfg.model,
              input: trimmed,
              voice: opts.voice ?? this.cfg.voice,
              response_format: this.cfg.format,
              speed: this.cfg.speed
            }),
            signal: controller.signal
          });
          if (!res.ok) throw new ProviderRequestError(`tts failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const data = Buffer.from(await res.arrayBuffer());
          if (data.byteLength < 128) throw new ProviderRequestError(`tts returned suspiciously small payload (${data.byteLength} bytes)`);
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
      detail: this.configured ? `configured (voice=${this.cfg.voice}, format=${this.cfg.format})` : 'not configured',
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
