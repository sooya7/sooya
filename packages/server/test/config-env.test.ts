import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

describe('web search environment configuration', () => {
  it('uses safe disabled defaults and the preferred provider order', () => {
    const env = loadEnv({ NODE_ENV: 'test' });

    expect(env.SOOYA_WEB_SEARCH_ENABLED).toBe(false);
    expect(env.SOOYA_WEB_SEARCH_PROVIDERS).toEqual(['doubao', 'tavily', 'responses']);
    expect(env.SOOYA_WEB_SEARCH_MAX_RESULTS).toBe(5);
    expect(env.SOOYA_WEB_SEARCH_TIMEOUT_MS).toBe(15_000);
    expect(env.SOOYA_DOUBAO_SEARCH_EDITION).toBe('custom');
    expect(env.SOOYA_DOUBAO_SEARCH_BASE_URL).toBe('https://open.feedcoopapi.com/search_api/web_search');
    expect(env.SOOYA_TAVILY_BASE_URL).toBe('https://api.tavily.com/search');
  });

  it('parses and deduplicates a configured provider chain', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      SOOYA_WEB_SEARCH_ENABLED: 'true',
      SOOYA_WEB_SEARCH_PROVIDERS: 'responses, tavily, doubao, tavily',
      SOOYA_WEB_SEARCH_MAX_RESULTS: '3',
      SOOYA_DOUBAO_SEARCH_EDITION: 'global'
    });

    expect(env.SOOYA_WEB_SEARCH_ENABLED).toBe(true);
    expect(env.SOOYA_WEB_SEARCH_PROVIDERS).toEqual(['responses', 'tavily', 'doubao']);
    expect(env.SOOYA_WEB_SEARCH_MAX_RESULTS).toBe(3);
    expect(env.SOOYA_DOUBAO_SEARCH_EDITION).toBe('global');
  });

  it('rejects unknown provider names', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', SOOYA_WEB_SEARCH_PROVIDERS: 'doubao,unknown' })).toThrow(
      /SOOYA_WEB_SEARCH_PROVIDERS/
    );
  });

  it('allows selecting any one provider without an implicit fallback', () => {
    expect(loadEnv({ NODE_ENV: 'test', SOOYA_WEB_SEARCH_PROVIDERS: 'responses' }).SOOYA_WEB_SEARCH_PROVIDERS).toEqual([
      'responses'
    ]);
    expect(loadEnv({ NODE_ENV: 'test', SOOYA_WEB_SEARCH_PROVIDERS: 'doubao' }).SOOYA_WEB_SEARCH_PROVIDERS).toEqual([
      'doubao'
    ]);
    expect(loadEnv({ NODE_ENV: 'test', SOOYA_WEB_SEARCH_PROVIDERS: 'tavily' }).SOOYA_WEB_SEARCH_PROVIDERS).toEqual([
      'tavily'
    ]);
  });
});
