import type { ImageModelConfig } from '../config/schema.js';
import { assertSafeUrl, safeFetch, withRetry, HttpTimeoutError } from '../util/http.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type GeneratedImage,
  type HealthStatus,
  type ImageProvider
} from './types.js';
import { normalizeAbort, safeText, type ProviderDeps } from './chat/openai.js';

export class OpenAIImageProvider implements ImageProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: ImageModelConfig,
    private readonly deps: ProviderDeps
  ) {
    this.name = cfg.provider;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.cfg.provider !== 'none' && !!this.cfg.baseUrl && !!this.cfg.model && !!this.cfg.apiKey;
  }

  private endpoint(suffix: string): string {
    const b = this.cfg.baseUrl.replace(/\/+$/, '');
    return b.endsWith(suffix) ? b : `${b}${suffix}`;
  }

  async generate(prompt: string, opts: { size?: string; signal?: AbortSignal } = {}): Promise<GeneratedImage> {
    if (!this.configured) throw new ProviderNotConfiguredError('image');
    return withRetry(
      async () => {
        const url = this.endpoint('/images/generations');
        const { signal, cancel } = this.timeout(opts.signal);
        try {
          await assertSafeUrl(url, this.deps.allowPrivateNetwork);
          const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
            body: JSON.stringify({
              model: this.cfg.model,
              prompt,
              size: opts.size ?? this.cfg.size,
              n: 1,
              response_format: 'b64_json'
            }),
            signal
          });
          if (!res.ok)
            throw new ProviderRequestError(`image generation failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string; mime_type?: string }> };
          return await this.materialize(json);
        } catch (err) {
          throw normalizeAbort(err, this.cfg.timeoutMs);
        } finally {
          cancel();
        }
      },
      { retries: this.cfg.maxRetries }
    );
  }

  async edit(prompt: string, image: Buffer, opts: { mime?: string; signal?: AbortSignal } = {}): Promise<GeneratedImage> {
    if (!this.configured) throw new ProviderNotConfiguredError('image');
    const url = this.endpoint('/images/edits');
    const { signal, cancel } = this.timeout(opts.signal);
    try {
      await assertSafeUrl(url, this.deps.allowPrivateNetwork);
      const form = new FormData();
      form.set('model', this.cfg.model);
      form.set('prompt', prompt);
      form.set('n', '1');
      const mime = opts.mime ?? 'image/png';
      form.set('image', new Blob([new Uint8Array(image)], { type: mime }), `image.${mime.split('/')[1] ?? 'png'}`);
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.apiKey}` },
        body: form,
        signal
      });
      if (!res.ok) throw new ProviderRequestError(`image edit failed with status ${res.status}: ${await safeText(res)}`, res.status);
      const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string; mime_type?: string }> };
      return await this.materialize(json);
    } catch (err) {
      throw normalizeAbort(err, this.cfg.timeoutMs);
    } finally {
      cancel();
    }
  }

  private async materialize(json: { data?: Array<{ b64_json?: string; url?: string; mime_type?: string }> }): Promise<GeneratedImage> {
    const first = json.data?.[0];
    if (!first) throw new ProviderRequestError('image response contained no data');
    if (first.b64_json) {
      const buf = Buffer.from(first.b64_json, 'base64');
      if (buf.byteLength === 0) throw new ProviderRequestError('image response was empty');
      return { data: buf, mime: first.mime_type ?? 'image/png' };
    }
    if (first.url) {
      const { response, body } = await safeFetch(first.url, {
        timeoutMs: this.cfg.timeoutMs,
        allowPrivateNetwork: this.deps.allowPrivateNetwork
      });
      if (!response.ok) throw new ProviderRequestError(`downloading generated image failed: ${response.status}`);
      if (body.byteLength === 0) throw new ProviderRequestError('downloaded image was empty');
      return { data: body, mime: response.headers.get('content-type') ?? 'image/png' };
    }
    throw new ProviderRequestError('image response contained neither b64_json nor url');
  }

  private timeout(external?: AbortSignal): { signal: AbortSignal; cancel: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new HttpTimeoutError(`image request timed out after ${this.cfg.timeoutMs}ms`)),
      this.cfg.timeoutMs
    );
    const onAbort = () => controller.abort(external?.reason);
    external?.addEventListener('abort', onAbort, { once: true });
    return {
      signal: controller.signal,
      cancel: () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      }
    };
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'image',
      configured: this.configured,
      ok: this.configured,
      provider: this.cfg.provider,
      model: this.cfg.model || undefined,
      detail: this.configured ? 'configured (endpoint not called)' : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export class UnconfiguredImageProvider implements ImageProvider {
  readonly name = 'none';
  readonly configured = false;
  async generate(): Promise<GeneratedImage> {
    throw new ProviderNotConfiguredError('image');
  }
  async edit(): Promise<GeneratedImage> {
    throw new ProviderNotConfiguredError('image');
  }
  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'image',
      configured: false,
      ok: false,
      provider: 'none',
      detail: 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export function createImageProvider(cfg: ImageModelConfig, deps: ProviderDeps): ImageProvider {
  if (cfg.provider === 'none') return new UnconfiguredImageProvider();
  return new OpenAIImageProvider(cfg, deps);
}
