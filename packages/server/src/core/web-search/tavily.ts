import type { WebSearchCitation, WebSearchProvider, WebSearchRequest, WebSearchResult } from './types.js';

export interface TavilySearchProviderOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

const COUNTRY_NAMES: Record<string, string> = {
  中国: 'china',
  china: 'china',
  cn: 'china',
  美国: 'united states',
  'united states': 'united states',
  us: 'united states'
};

export class TavilySearchProvider implements WebSearchProvider {
  readonly name = 'tavily' as const;
  readonly configured: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TavilySearchProviderOptions) {
    this.configured = Boolean(options.apiKey.trim() && options.baseUrl.trim());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult> {
    if (!this.configured) throw new Error('tavily search is not configured');
    const country = request.country ? COUNTRY_NAMES[request.country.trim().toLowerCase()] : undefined;
    const body = {
      query: tavilyQuery(request.query),
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      max_results: Math.max(1, Math.min(request.maxResults, 5)),
      ...(request.freshness ? { time_range: request.freshness } : {}),
      ...(country ? { country } : {})
    };
    const response = await this.fetchImpl(this.options.baseUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: request.signal
    });
    if (!response.ok) throw new Error(`tavily search failed with status ${response.status}`);

    const payload = (await response.json()) as { results?: Array<Record<string, unknown>> };
    const citations = (payload.results ?? [])
      .map(normalizeTavilyCitation)
      .filter((item): item is WebSearchCitation => item !== null)
      .slice(0, body.max_results);
    return { provider: this.name, query: request.query, citations };
  }
}

/** Tavily currently rejects CJK-only queries as invalid; a neutral ASCII prefix preserves the query semantics. */
function tavilyQuery(query: string): string {
  const trimmed = query.trim();
  return /[a-z0-9]/iu.test(trimmed) ? trimmed : `web search: ${trimmed}`;
}

function normalizeTavilyCitation(item: Record<string, unknown>): WebSearchCitation | null {
  const url = safeWebUrl(item.url);
  if (!url) return null;
  const snippet = boundedText(item.content);
  return {
    title: text(item.title) || new URL(url).hostname,
    url,
    ...(snippet ? { snippet } : {})
  };
}

function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedText(value: unknown): string {
  return text(value).slice(0, 1_200);
}
