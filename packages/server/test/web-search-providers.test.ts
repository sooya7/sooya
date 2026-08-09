import { describe, expect, it } from 'vitest';
import { DoubaoSearchProvider } from '../src/core/web-search/doubao.js';
import { TavilySearchProvider } from '../src/core/web-search/tavily.js';

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
});
