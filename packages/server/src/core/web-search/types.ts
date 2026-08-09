export type WebSearchProviderName = 'doubao' | 'tavily' | 'responses';
export type ExternalWebSearchProviderName = Exclude<WebSearchProviderName, 'responses'>;
export type WebSearchFreshness = 'day' | 'week' | 'month' | 'year';

export interface WebSearchRequest {
  query: string;
  maxResults: number;
  city?: string;
  region?: string;
  country?: string;
  freshness?: WebSearchFreshness;
  signal?: AbortSignal;
}

export interface WebSearchCitation {
  title: string;
  url: string;
  snippet?: string;
  siteName?: string;
  publishedAt?: string;
}

export interface WebSearchResult {
  provider: WebSearchProviderName;
  query: string;
  citations: WebSearchCitation[];
}

export interface WebSearchProvider {
  readonly name: ExternalWebSearchProviderName;
  readonly configured: boolean;
  search(request: WebSearchRequest): Promise<WebSearchResult>;
}
