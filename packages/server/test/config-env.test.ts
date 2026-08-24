import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

describe('web search environment configuration', () => {
  it('keeps test and standalone CI harnesses on legacy memory unless opted in', () => {
    const testDefaults = loadEnv({ NODE_ENV: 'test' });
    expect(testDefaults.MEMORY_BACKEND).toBe('legacy');
    expect(testDefaults.MCP_CONNECT_ON_START).toBe(false);

    const explicitOmbre = loadEnv({ NODE_ENV: 'test', MEMORY_BACKEND: 'ombre', MCP_CONNECT_ON_START: 'true' });
    expect(explicitOmbre.MEMORY_BACKEND).toBe('ombre');
    expect(explicitOmbre.MCP_CONNECT_ON_START).toBe(true);
    expect(loadEnv({ NODE_ENV: 'production' }).MEMORY_BACKEND).toBe('ombre');
  });

  it('enables the next-stage engines and proactive reach-out by default while preserving explicit kill switches', () => {
    const enabled = loadEnv({ NODE_ENV: 'test' });
    expect(enabled.FUTURE_ENGINE_ENABLED).toBe(true);
    expect(enabled.FUTURE_PROACTIVE_ENABLED).toBe(true);
    expect(enabled.RELATIONSHIP_CONTEXT_ENABLED).toBe(true);
    expect(enabled.TIMELINE_ENABLED).toBe(true);
    expect(enabled.INTERACTION_LEARNING_ENABLED).toBe(true);
    expect(enabled.ADAPTIVE_PROVIDER_ROUTING_ENABLED).toBe(true);
    expect(enabled.ENABLE_LIFE_REACH_OUT).toBe(true);

    const disabled = loadEnv({
      NODE_ENV: 'test',
      FUTURE_ENGINE_ENABLED: 'false',
      FUTURE_PROACTIVE_ENABLED: 'false',
      RELATIONSHIP_CONTEXT_ENABLED: 'false',
      TIMELINE_ENABLED: 'false',
      INTERACTION_LEARNING_ENABLED: 'false',
      ADAPTIVE_PROVIDER_ROUTING_ENABLED: 'false',
      ENABLE_LIFE_REACH_OUT: 'false'
    });
    expect(disabled.FUTURE_ENGINE_ENABLED).toBe(false);
    expect(disabled.FUTURE_PROACTIVE_ENABLED).toBe(false);
    expect(disabled.RELATIONSHIP_CONTEXT_ENABLED).toBe(false);
    expect(disabled.TIMELINE_ENABLED).toBe(false);
    expect(disabled.INTERACTION_LEARNING_ENABLED).toBe(false);
    expect(disabled.ADAPTIVE_PROVIDER_ROUTING_ENABLED).toBe(false);
    expect(disabled.ENABLE_LIFE_REACH_OUT).toBe(false);
  });

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

  it('enables world context by default with Open-Meteo as the keyless provider', () => {
    const env = loadEnv({ NODE_ENV: 'test' });
    expect(env.WORLD_CONTEXT_ENABLED).toBe(true);
    expect(env.LOCATION_MODEL_ENABLED).toBe(true);
    expect(env.WEATHER_ENABLED).toBe(true);
    expect(env.WEATHER_PROVIDER).toBe('open-meteo');
  });

  it('keeps explicit world flags and a blank provider as kill switches/fallbacks', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      WORLD_CONTEXT_ENABLED: 'false',
      LOCATION_MODEL_ENABLED: 'false',
      WEATHER_ENABLED: 'false',
      WEATHER_PROVIDER: '   '
    });
    expect(env.WORLD_CONTEXT_ENABLED).toBe(false);
    expect(env.LOCATION_MODEL_ENABLED).toBe(false);
    expect(env.WEATHER_ENABLED).toBe(false);
    expect(env.WEATHER_PROVIDER).toBe('open-meteo');
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
