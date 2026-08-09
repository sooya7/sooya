import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

const ADMIN = { 'x-admin-token': 'admin-test-token' };
let h: Harness | null = null;

afterEach(async () => {
  if (h) await h.cleanup();
  h = null;
});

async function saveWebSearch(patch: Record<string, unknown>) {
  return await h!.app.server.inject({
    method: 'PUT',
    url: '/api/admin/models',
    headers: ADMIN,
    payload: { webSearch: patch }
  });
}

describe('web search model administration', () => {
  it('saves search through the existing models endpoint and rebuilds it immediately', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' } });
    const response = await saveWebSearch({
      enabled: true,
      providers: ['tavily'],
      tavily: { apiKey: 'saved-tavily-secret' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().models.webSearch).toMatchObject({
      enabled: true,
      providers: ['tavily'],
      tavily: { apiKeyConfigured: true }
    });
    expect(response.body).not.toContain('saved-tavily-secret');
    expect(h.app.services.webSearch.enabled).toBe(true);
    expect(h.app.services.webSearch.order).toEqual(['tavily']);
  });

  it('runs a real saved-provider test without returning its key', async () => {
    h = await createHarness({
      env: { ADMIN_API_TOKEN: 'admin-test-token' },
      webSearch: {
        doubao: { Result: { WebResults: [{ Title: 'OpenAI', Url: 'https://example.com/openai' }] } }
      }
    });
    await saveWebSearch({ enabled: true, providers: ['doubao'], doubao: { apiKey: 'doubao-test-secret' } });

    const response = await h.app.server.inject({
      method: 'POST',
      url: '/api/admin/models/web-search/test',
      headers: ADMIN,
      payload: { provider: 'doubao', query: 'OpenAI' }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, provider: 'doubao', resultCount: 1 });
    expect(response.json().latencyMs).toBeTypeOf('number');
    expect(response.body).not.toContain('doubao-test-secret');
  });

  it('reports native Responses search as unavailable for an incompatible chat model', async () => {
    h = await createHarness({ env: { ADMIN_API_TOKEN: 'admin-test-token' }, chatProvider: 'openai-chat' });
    await saveWebSearch({ enabled: true, providers: ['responses'] });
    const response = await h.app.server.inject({
      method: 'POST',
      url: '/api/admin/models/web-search/test',
      headers: ADMIN,
      payload: { provider: 'responses', query: 'OpenAI' }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'responses_search_unavailable' });
  });
});
