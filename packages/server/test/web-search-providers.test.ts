import { describe, expect, it } from 'vitest';
import { DoubaoSearchProvider } from '../src/core/web-search/doubao.js';
import { TavilySearchProvider } from '../src/core/web-search/tavily.js';
import { WebSearchService, formatWebSearchContext } from '../src/core/web-search/service.js';
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '../src/core/web-search/types.js';

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function capture(response: unknown, status = 200) {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  };
  return { fetchImpl, requests };
}

describe('DoubaoSearchProvider', () => {
  it('sends the Custom API contract and normalizes safe citations', async () => {
    const fake = capture({
      Result: {
        WebResults: [
          { Title: '宁波活动', Url: 'https://example.com/event', Summary: '本周活动摘要', SiteName: '示例站', PublishTime: '2026-08-09' },
          { Title: '危险链接', Url: 'javascript:alert(1)', Summary: 'ignore' }
        ]
      }
    });
    const provider = new DoubaoSearchProvider({
      apiKey: 'doubao-secret',
      baseUrl: 'https://open.feedcoopapi.com/search_api/web_search',
      edition: 'custom',
      fetchImpl: fake.fetchImpl
    });

    const result = await provider.search({ query: '宁波今天有什么活动', maxResults: 5, freshness: 'day' });

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.url).toBe('https://open.feedcoopapi.com/search_api/web_search');
    expect(fake.requests[0]!.headers.get('authorization')).toBe('Bearer doubao-secret');
    expect(fake.requests[0]!.body).toMatchObject({
      Query: '宁波今天有什么活动',
      SearchType: 'web',
      Count: 5,
      NeedSummary: true,
      TimeRange: 'OneDay',
      QueryControl: { QueryRewrite: true },
      Filter: { AuthInfoLevel: 0 }
    });
    expect(result).toEqual({
      provider: 'doubao',
      query: '宁波今天有什么活动',
      citations: [
        {
          title: '宁波活动',
          url: 'https://example.com/event',
          snippet: '本周活动摘要',
          siteName: '示例站',
          publishedAt: '2026-08-09'
        }
      ]
    });
  });

  it('omits Custom-only controls and caps Global results at 20', async () => {
    const fake = capture({ Result: { WebResults: [] } });
    const provider = new DoubaoSearchProvider({
      apiKey: 'doubao-secret',
      baseUrl: 'https://global.example/search',
      edition: 'global',
      fetchImpl: fake.fetchImpl
    });

    await provider.search({ query: 'global news', maxResults: 50 });

    expect(fake.requests[0]!.body.Count).toBe(20);
    expect(fake.requests[0]!.body).not.toHaveProperty('Filter');
  });

  it('reports a redacted provider error', async () => {
    const fake = capture({ error: 'response-secret-payload' }, 401);
    const provider = new DoubaoSearchProvider({
      apiKey: 'doubao-secret',
      baseUrl: 'https://example.com/search',
      edition: 'custom',
      fetchImpl: fake.fetchImpl
    });

    const error = await provider.search({ query: 'private query', maxResults: 5 }).catch((value) => value as Error);

    expect(error.message).toMatch(/doubao search failed.*401/i);
    expect(error.message).not.toContain('doubao-secret');
    expect(error.message).not.toContain('response-secret-payload');
    expect(error.message).not.toContain('private query');
  });
});

describe('TavilySearchProvider', () => {
  it('uses one-credit search settings and normalizes results', async () => {
    const fake = capture({
      results: [
        { title: 'Tavily result', url: 'https://news.example/item', content: 'short content', score: 0.9 },
        { title: 'Unsafe', url: 'file:///etc/passwd', content: 'ignore' }
      ]
    });
    const provider = new TavilySearchProvider({
      apiKey: 'tavily-secret',
      baseUrl: 'https://api.tavily.com/search',
      fetchImpl: fake.fetchImpl
    });

    const result = await provider.search({ query: 'latest release', maxResults: 20, country: '中国' });

    expect(fake.requests[0]!.headers.get('authorization')).toBe('Bearer tavily-secret');
    expect(fake.requests[0]!.body).toEqual({
      query: 'latest release',
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      max_results: 5,
      country: 'china'
    });
    expect(result.citations).toEqual([
      { title: 'Tavily result', url: 'https://news.example/item', snippet: 'short content' }
    ]);
  });

  it('maps freshness and keeps long snippets bounded', async () => {
    const fake = capture({ results: [{ title: '', url: 'https://example.com', content: 'x'.repeat(2_000) }] });
    const provider = new TavilySearchProvider({ apiKey: 'key', baseUrl: 'https://api.tavily.com/search', fetchImpl: fake.fetchImpl });

    const result = await provider.search({ query: 'news', maxResults: 3, freshness: 'week' });

    expect(fake.requests[0]!.body.time_range).toBe('week');
    expect(result.citations[0]!.title).toBe('example.com');
    expect(result.citations[0]!.snippet).toHaveLength(1_200);
  });

  it('adds a neutral ASCII prefix when Tavily rejects a CJK-only query', async () => {
    const fake = capture({ results: [] });
    const provider = new TavilySearchProvider({ apiKey: 'key', baseUrl: 'https://api.tavily.com/search', fetchImpl: fake.fetchImpl });

    await provider.search({ query: '宁波今天有什么活动', maxResults: 3, country: '中国' });

    expect(fake.requests[0]!.body.query).toBe('web search: 宁波今天有什么活动');
  });
});

function fakeProvider(
  name: 'doubao' | 'tavily',
  implementation: (request: WebSearchRequest) => Promise<WebSearchResult>,
  configured = true
): WebSearchProvider & { calls: number } {
  return {
    name,
    configured,
    calls: 0,
    async search(request) {
      this.calls++;
      return implementation(request);
    }
  };
}

describe('WebSearchService', () => {
  it('falls through the selected order including the Responses candidate', async () => {
    const doubao = fakeProvider('doubao', async () => {
      throw new Error('doubao search failed with status 429');
    });
    const tavily = fakeProvider('tavily', async (request) => ({
      provider: 'tavily',
      query: request.query,
      citations: [{ title: 'fallback', url: 'https://example.com/fallback', snippet: 'ok' }]
    }));
    let responsesCalls = 0;
    const errors: string[] = [];
    const service = new WebSearchService({
      order: ['doubao', 'tavily', 'responses'],
      providers: [doubao, tavily],
      maxResults: 5,
      timeoutMs: 1_000,
      onError: (_provider, error) => errors.push(error.message)
    });

    const result = await service.resolve(
      { query: 'latest', maxResults: 50 },
      async () => {
        responsesCalls++;
        return { provider: 'responses', query: 'latest', citations: [], answer: 'native' };
      }
    );

    expect(result?.provider).toBe('tavily');
    expect(doubao.calls).toBe(1);
    expect(tavily.calls).toBe(1);
    expect(responsesCalls).toBe(0);
    expect(errors).toEqual(['doubao search failed with status 429']);
  });

  it('uses Responses first when selected and does not call later providers after success', async () => {
    const tavily = fakeProvider('tavily', async () => ({ provider: 'tavily', query: 'q', citations: [] }));
    const service = new WebSearchService({
      order: ['responses', 'tavily'],
      providers: [tavily],
      maxResults: 5,
      timeoutMs: 1_000
    });

    const result = await service.resolve(
      { query: 'q', maxResults: 5 },
      async () => ({ provider: 'responses', query: 'q', citations: [], answer: 'native answer' })
    );

    expect(result).toMatchObject({ provider: 'responses', answer: 'native answer' });
    expect(tavily.calls).toBe(0);
  });

  it('does not add an implicit fallback when only one provider is selected', async () => {
    const doubao = fakeProvider('doubao', async () => {
      throw new Error('down');
    });
    const tavily = fakeProvider('tavily', async () => ({
      provider: 'tavily',
      query: 'q',
      citations: [{ title: 'unused', url: 'https://example.com' }]
    }));
    const service = new WebSearchService({
      order: ['doubao'],
      providers: [doubao, tavily],
      maxResults: 5,
      timeoutMs: 1_000
    });

    expect(await service.resolve({ query: 'q', maxResults: 5 })).toBeNull();
    expect(tavily.calls).toBe(0);
  });

  it('aborts a timed-out provider request before falling back', async () => {
    let aborted = false;
    const doubao = fakeProvider('doubao', async (request) => {
      await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(request.signal?.reason);
          },
          { once: true }
        );
      });
      throw new Error('unreachable');
    });
    const tavily = fakeProvider('tavily', async () => ({
      provider: 'tavily',
      query: 'q',
      citations: [{ title: 'fallback', url: 'https://example.com' }]
    }));
    const service = new WebSearchService({
      order: ['doubao', 'tavily'],
      providers: [doubao, tavily],
      maxResults: 5,
      timeoutMs: 5
    });

    const result = await service.resolve({ query: 'q', maxResults: 5 });

    expect(aborted).toBe(true);
    expect(result?.provider).toBe('tavily');
  });

  it('deduplicates and bounds the untrusted context sent to the chat model', () => {
    const context = formatWebSearchContext({
      provider: 'doubao',
      query: 'q',
      citations: [
        { title: 'A', url: 'https://example.com/a', snippet: 'x'.repeat(3_000), siteName: 'Example' },
        { title: 'duplicate', url: 'https://example.com/a', snippet: 'ignored' },
        { title: 'B', url: 'https://example.com/b', snippet: 'short' }
      ]
    });

    expect(context).toContain('外部不可信内容');
    expect(context).toContain('[1] A | Example | https://example.com/a');
    expect(context).toContain('[2] B | https://example.com/b');
    expect(context).not.toContain('duplicate');
    expect(context.length).toBeLessThanOrEqual(7_000);
  });
});
