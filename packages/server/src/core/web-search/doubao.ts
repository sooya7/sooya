import type { WebSearchCitation, WebSearchProvider, WebSearchRequest, WebSearchResult } from './types.js';

export interface DoubaoSearchProviderOptions {
  apiKey: string;
  baseUrl: string;
  edition: 'custom' | 'global';
  fetchImpl?: typeof fetch;
}

const TIME_RANGE = {
  day: 'OneDay',
  week: 'OneWeek',
  month: 'OneMonth',
  year: 'OneYear'
} as const;

export class DoubaoSearchProvider implements WebSearchProvider {
  readonly name = 'doubao' as const;
  readonly configured: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DoubaoSearchProviderOptions) {
    this.configured = Boolean(options.apiKey.trim() && options.baseUrl.trim());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult> {
    if (!this.configured) throw new Error('doubao search is not configured');
    const body: Record<string, unknown> = {
      Query: request.query,
      SearchType: 'web',
      Count: Math.max(1, Math.min(request.maxResults, this.options.edition === 'global' ? 20 : 50)),
      NeedSummary: true,
      QueryControl: { QueryRewrite: true }
    };
    if (request.freshness) body.TimeRange = TIME_RANGE[request.freshness];
    if (this.options.edition === 'custom') body.Filter = { AuthInfoLevel: 0 };

    const response = await this.fetchImpl(this.options.baseUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: request.signal
    });
    if (!response.ok) throw new Error(`doubao search failed with status ${response.status}`);

    const payload = (await response.json()) as {
      Result?: { WebResults?: Array<Record<string, unknown>> };
    };
    const citations = (payload.Result?.WebResults ?? [])
      .map(normalizeDoubaoCitation)
      .filter((item): item is WebSearchCitation => item !== null)
      .slice(0, request.maxResults);
    return { provider: this.name, query: request.query, citations };
  }
}

function normalizeDoubaoCitation(item: Record<string, unknown>): WebSearchCitation | null {
  const url = safeWebUrl(item.Url);
  if (!url) return null;
  const snippet = boundedText(item.Summary ?? item.Snippet);
  const siteName = text(item.SiteName);
  const publishedAt = text(item.PublishTime ?? item.PublishDate ?? item.DatePublished);
  return {
    title: text(item.Title) || new URL(url).hostname,
    url,
    ...(snippet ? { snippet } : {}),
    ...(siteName ? { siteName } : {}),
    ...(publishedAt ? { publishedAt } : {})
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
