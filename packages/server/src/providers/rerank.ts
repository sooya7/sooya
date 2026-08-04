import type { RerankModelConfig } from '../config/schema.js';
import { assertSafeUrl, withRetry, HttpTimeoutError } from '../util/http.js';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type HealthStatus,
  type RerankMatch,
  type RerankProvider
} from './types.js';
import { safeText, normalizeAbort } from './chat/openai.js';
import type { ProviderDeps } from './chat/openai.js';

/**
 * Cross-encoder style reranking over the OpenAI-compatible `POST /rerank`
 * protocol (SiliconFlow, Jina-style gateways): the body carries the query and
 * the candidate documents, the response ranks them by relevance. Absolute
 * scores are not comparable across models, so callers should only rely on
 * the returned ordering.
 */
export class OpenAIRerankProvider implements RerankProvider {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: RerankModelConfig,
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
    return b.endsWith('/rerank') ? b : `${b}/rerank`;
  }

  async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<RerankMatch[]> {
    if (!this.configured) throw new ProviderNotConfiguredError('rerank');
    if (documents.length === 0) return [];
    return withRetry(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new HttpTimeoutError(`rerank timed out after ${this.cfg.timeoutMs}ms`)),
          this.cfg.timeoutMs
        );
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await assertSafeUrl(this.endpoint(), this.deps.allowPrivateNetwork);
          const res = await this.fetchImpl(this.endpoint(), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
            body: JSON.stringify({ model: this.cfg.model, query, documents }),
            signal: controller.signal
          });
          if (!res.ok)
            throw new ProviderRequestError(`rerank failed with status ${res.status}: ${await safeText(res)}`, res.status);
          const json = (await res.json()) as { results?: Array<{ index?: number; relevance_score?: number }> };
          const rows = json.results ?? [];
          const matches: RerankMatch[] = [];
          for (const row of rows) {
            const index = row.index;
            const score = row.relevance_score;
            if (typeof index !== 'number' || index < 0 || index >= documents.length) continue;
            if (typeof score !== 'number' || !Number.isFinite(score)) continue;
            matches.push({ index, score });
          }
          if (matches.length === 0) throw new ProviderRequestError('rerank response contained no usable results');
          return matches.sort((a, b) => b.score - a.score);
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
      capability: 'rerank',
      configured: this.configured,
      ok: this.configured,
      provider: this.cfg.provider,
      model: this.cfg.model || undefined,
      detail: this.configured ? 'configured (endpoint not called)' : 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export class UnconfiguredRerankProvider implements RerankProvider {
  readonly name = 'none';
  readonly configured = false;
  async rerank(): Promise<RerankMatch[]> {
    throw new ProviderNotConfiguredError('rerank');
  }
  async inspectHealth(): Promise<HealthStatus> {
    return {
      capability: 'rerank',
      configured: false,
      ok: false,
      provider: 'none',
      detail: 'not configured',
      checkedAt: new Date().toISOString()
    };
  }
}

export function createRerankProvider(cfg: RerankModelConfig, deps: ProviderDeps): RerankProvider {
  if (cfg.provider === 'none') return new UnconfiguredRerankProvider();
  return new OpenAIRerankProvider(cfg, deps);
}
