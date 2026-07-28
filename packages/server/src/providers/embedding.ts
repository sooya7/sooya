import type { EmbeddingModelConfig } from '../config/schema.js';
import { assertSafeUrl, withRetry, HttpTimeoutError } from '../util/http.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type EmbeddingProvider,
  type EmbeddingResult,
  type HealthStatus
} from './types.js';
import { safeText, normalizeAbort } from './chat/openai.js';
import type { ProviderDeps } from './chat/openai.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;
  /** Learned from the first successful response when not configured explicitly. */
  private observedDim: number | null = null;

  constructor(
    private readonly cfg: EmbeddingModelConfig,
    private readonly deps: ProviderDeps
  ) {
    this.name = cfg.provider;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.cfg.provider !== 'none' && !!this.cfg.baseUrl && !!this.cfg.model && !!this.cfg.apiKey;
  }

  /** Never a global constant: config first, then observed response. */
  get dimensions(): number | null {
    return this.cfg.dimensions ?? this.observedDim;
  }

  private endpoint(): string {
    const b = this.cfg.baseUrl.replace(/\/+$/, '');
    return b.endsWith('/embeddings') ? b : `${b}/embeddings`;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    if (!this.configured) throw new ProviderNotConfiguredError('embedding');
    if (texts.length === 0) return { vectors: [], model: this.cfg.model, dimensions: this.dimensions ?? 0 };
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new HttpTimeoutError(`embedding timed out after ${this.cfg.timeoutMs}ms`)),
          this.cfg.timeoutMs
        );
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
          const body: Record<string, unknown> = { model: this.cfg.model, input: texts };
          if (this.cfg.dimensions) body.dimensions = this.cfg.dimensions;
          const res = await this.fetchImpl(this.endpoint(), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
            body: JSON.stringify(body),
            signal: controller.signal
          });
          if (!res.ok)
            throw new ProviderRequestError(`embedding failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const json = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }>; model?: string };
          const rows = (json.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
          const vectors = rows.map((r) => r.embedding);
          if (vectors.length === 0) throw new ProviderRequestError('embedding response contained no vectors');
          const dim = vectors[0]!.length;
          if (vectors.some((v) => v.length !== dim)) throw new ProviderRequestError('embedding response has inconsistent dimensions');
          if (this.cfg.dimensions && dim !== this.cfg.dimensions) {
            throw new ProviderRequestError(`embedding dimension mismatch: expected ${this.cfg.dimensions}, got ${dim}`);
          }
          this.observedDim = dim;
          return { vectors, model: json.model ?? this.cfg.model, dimensions: dim };
        } catch (err) {
          throw normalizeAbort(err, this.cfg.timeoutMs);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        }
      },
      { retries: this.cfg.maxRetries }
    );
  }

  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'embedding',
      configured: this.configured,
      ok: this.configured,
      provider: this.cfg.provider,
      model: this.cfg.model || undefined,
      detail: this.configured
        ? `configured${this.dimensions ? ` (dim=${this.dimensions})` : ' (dimension unknown until first call)'}`
        : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export class UnconfiguredEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none';
  readonly configured = false;
  readonly dimensions = null;
  async embed(): Promise<EmbeddingResult> {
    throw new ProviderNotConfiguredError('embedding');
  }
  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'embedding',
      configured: false,
      ok: false,
      provider: 'none',
      detail: 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export function createEmbeddingProvider(cfg: EmbeddingModelConfig, deps: ProviderDeps): EmbeddingProvider {
  if (cfg.provider === 'none') return new UnconfiguredEmbeddingProvider();
  return new OpenAIEmbeddingProvider(cfg, deps);
}
