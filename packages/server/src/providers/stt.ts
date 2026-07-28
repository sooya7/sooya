import type { SttModelConfig } from '../config/schema.js';
import { assertSafeUrl, withRetry, HttpTimeoutError } from '../util/http.js';
import { probeAudioDuration } from '../util/audio.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type HealthStatus,
  type STTProvider,
  type TranscriptionResult
} from './types.js';
import { normalizeAbort, safeText, type ProviderDeps } from './chat/openai.js';

export class OpenAISTTProvider implements STTProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: SttModelConfig,
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
    return b.endsWith('/audio/transcriptions') ? b : `${b}/audio/transcriptions`;
  }

  async transcribe(
    audio: Buffer,
    opts: { mime?: string; filename?: string; signal?: AbortSignal } = {}
  ): Promise<TranscriptionResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('stt');
    if (audio.byteLength === 0) throw new ProviderRequestError('stt requires non-empty audio');
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new HttpTimeoutError(`stt timed out after ${this.cfg.timeoutMs}ms`)),
          this.cfg.timeoutMs
        );
        const onAbort = () => controller.abort(opts.signal?.reason);
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
          const form = new FormData();
          form.set('model', this.cfg.model);
          if (this.cfg.language) form.set('language', this.cfg.language);
          form.set(
            'file',
            new Blob([new Uint8Array(audio)], { type: opts.mime ?? 'audio/webm' }),
            opts.filename ?? 'audio.webm'
          );
          const res = await this.fetchImpl(this.endpoint(), {
            method: 'POST',
            headers: { authorization: `Bearer ${this.cfg.apiKey}` },
            body: form,
            signal: controller.signal
          });
          if (!res.ok) throw new ProviderRequestError(`stt failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const json = (await res.json()) as { text?: string; duration?: number; language?: string };
          const text = (json.text ?? '').trim();
          if (!text) throw new ProviderRequestError('stt returned empty transcript');
          return {
            text,
            durationSec: json.duration ?? probeAudioDuration(audio, opts.mime) ?? undefined,
            language: json.language
          };
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
      capability: 'stt',
      configured: this.configured,
      ok: this.configured,
      provider: this.cfg.provider,
      model: this.cfg.model || undefined,
      detail: this.configured ? 'configured (endpoint not called)' : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export class UnconfiguredSTTProvider implements STTProvider {
  readonly name = 'none';
  readonly configured = false;
  async transcribe(): Promise<TranscriptionResult> {
    throw new ProviderNotConfiguredError('stt');
  }
  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'stt',
      configured: false,
      ok: false,
      provider: 'none',
      detail: 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export function createSTTProvider(cfg: SttModelConfig, deps: ProviderDeps): STTProvider {
  if (cfg.provider === 'none') return new UnconfiguredSTTProvider();
  return new OpenAISTTProvider(cfg, deps);
}
