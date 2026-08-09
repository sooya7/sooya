import { describe, expect, it, vi } from 'vitest';
import { ModelsConfigSchema } from '../src/config/schema.js';
import { WebSearchRegistry } from '../src/core/web-search/registry.js';

const request = { query: 'OpenAI', maxResults: 5 };

describe('WebSearchRegistry', () => {
  it('rebuilds the provider order from models.json without restarting', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('tavily')) {
        return new Response(JSON.stringify({ results: [{ title: 'Tavily', url: 'https://example.com/tavily', content: 'ok' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ Result: { WebResults: [{ Title: 'Doubao', Url: 'https://example.com/doubao' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as unknown as typeof fetch;
    const registry = new WebSearchRegistry({ fetchImpl });
    const models = ModelsConfigSchema.parse({
      webSearch: {
        enabled: true,
        providers: ['tavily', 'doubao'],
        tavily: { apiKey: 'tavily-key' },
        doubao: { apiKey: 'doubao-key' }
      }
    });

    registry.rebuild(models.webSearch);
    expect(registry.enabled).toBe(true);
    expect(registry.order).toEqual(['tavily', 'doubao']);
    expect((await registry.resolve(request))?.provider).toBe('tavily');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('tavily');
  });

  it('stops searching immediately when the page disables it', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const registry = new WebSearchRegistry({ fetchImpl });
    registry.rebuild(ModelsConfigSchema.parse({ webSearch: { enabled: true, providers: ['doubao'], doubao: { apiKey: 'key' } } }).webSearch);
    registry.rebuild(ModelsConfigSchema.parse({ webSearch: { enabled: false } }).webSearch);

    expect(registry.enabled).toBe(false);
    expect(registry.order).toEqual([]);
    expect(await registry.resolve(request)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
