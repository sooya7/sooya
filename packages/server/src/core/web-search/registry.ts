import type { WebSearchConfig } from '../../config/schema.js';
import { DoubaoSearchProvider } from './doubao.js';
import { TavilySearchProvider } from './tavily.js';
import { WebSearchService } from './service.js';
import type { WebSearchProviderName, WebSearchRequest, WebSearchResult } from './types.js';

export interface WebSearchRegistryOptions {
  fetchImpl?: typeof fetch;
  onError?: (provider: WebSearchProviderName, error: Error) => void;
}

export interface WebSearchResolver {
  resolve(
    request: WebSearchRequest,
    nativeSearch?: (signal: AbortSignal) => Promise<WebSearchResult | null>
  ): Promise<WebSearchResult | null>;
}

/** A stable dependency whose internal provider chain can be replaced live. */
export class WebSearchRegistry implements WebSearchResolver {
  private service: WebSearchService | null = null;
  private config: WebSearchConfig | null = null;

  constructor(private readonly options: WebSearchRegistryOptions = {}) {}

  get enabled(): boolean {
    return this.service !== null;
  }

  get order(): readonly WebSearchProviderName[] {
    return this.service?.order ?? [];
  }

  rebuild(config: WebSearchConfig): void {
    this.config = config;
    if (!config.enabled) {
      this.service = null;
      return;
    }
    this.service = this.buildService(config, config.providers);
  }

  async test(
    provider: WebSearchProviderName,
    request: WebSearchRequest,
    nativeSearch?: (signal: AbortSignal) => Promise<WebSearchResult | null>
  ): Promise<WebSearchResult | null> {
    if (!this.config) return null;
    return await this.buildService(this.config, [provider]).resolve(request, nativeSearch);
  }

  private buildService(config: WebSearchConfig, order: WebSearchProviderName[]): WebSearchService {
    return new WebSearchService({
      order,
      providers: [
        new DoubaoSearchProvider({
          apiKey: config.doubao.apiKey,
          baseUrl: config.doubao.baseUrl,
          edition: config.doubao.edition,
          fetchImpl: this.options.fetchImpl
        }),
        new TavilySearchProvider({
          apiKey: config.tavily.apiKey,
          baseUrl: config.tavily.baseUrl,
          fetchImpl: this.options.fetchImpl
        })
      ],
      maxResults: config.maxResults,
      timeoutMs: config.timeoutMs,
      onError: this.options.onError
    });
  }

  async resolve(
    request: WebSearchRequest,
    nativeSearch?: (signal: AbortSignal) => Promise<WebSearchResult | null>
  ): Promise<WebSearchResult | null> {
    return this.service ? await this.service.resolve(request, nativeSearch) : null;
  }
}
