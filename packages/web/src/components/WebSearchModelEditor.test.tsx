// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSearchModelEditor } from './WebSearchModelEditor.js';
import type { AdminWebSearchConfig } from '../lib/admin.js';

const api = vi.hoisted(() => ({
  updateModels: vi.fn(async (patch: Record<string, unknown>) => ({ models: patch })),
  testWebSearch: vi.fn(async (provider: string) => ({ ok: true, provider, latencyMs: 12, resultCount: 2 }))
}));

vi.mock('../lib/admin.js', () => ({ adminApi: api }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const config: AdminWebSearchConfig = {
  enabled: true,
  providers: ['doubao', 'tavily', 'responses'],
  maxResults: 5,
  timeoutMs: 15000,
  doubao: {
    edition: 'custom' as const,
    baseUrl: 'https://open.feedcoopapi.com/search_api/web_search',
    apiKeyConfigured: true
  },
  tavily: {
    baseUrl: 'https://api.tavily.com/search',
    apiKeyConfigured: true
  }
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.updateModels.mockClear();
  api.testWebSearch.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('WebSearchModelEditor', () => {
  it('renders every search setting inside the model editor without exposing keys', async () => {
    await act(async () => root!.render(<WebSearchModelEditor config={config} responsesAvailable onSaved={vi.fn()} onNotice={vi.fn()} />));

    expect((container!.querySelector('[aria-label="启用联网搜索"]') as HTMLInputElement).checked).toBe(true);
    expect((container!.querySelector('[aria-label="豆包版本"]') as HTMLSelectElement).value).toBe('custom');
    expect(container!.textContent).toContain('Tavily');
    expect(container!.textContent).toContain('Responses');
    expect(container!.textContent).toContain('已配置');
    expect(container!.textContent).not.toContain('doubao-secret');
  });

  it('reorders providers and saves edited values through the existing models endpoint', async () => {
    const onSaved = vi.fn();
    await act(async () => root!.render(<WebSearchModelEditor config={config} responsesAvailable onSaved={onSaved} onNotice={vi.fn()} />));
    const edition = container!.querySelector('[aria-label="豆包版本"]') as HTMLSelectElement;
    await act(async () => {
      edition.value = 'global';
      edition.dispatchEvent(new Event('change', { bubbles: true }));
      (container!.querySelector('[aria-label="上移 Tavily"]') as HTMLButtonElement).click();
    });
    await act(async () => (container!.querySelector('[data-testid="save-web-search"]') as HTMLButtonElement).click());

    expect(api.updateModels).toHaveBeenCalledTimes(1);
    const patch = api.updateModels.mock.calls[0]![0] as any;
    expect(patch.webSearch.providers).toEqual(['tavily', 'doubao', 'responses']);
    expect(patch.webSearch.doubao.edition).toBe('global');
    expect(patch.webSearch.doubao.apiKey).toBeUndefined();
    expect(onSaved).toHaveBeenCalled();
  });

  it('tests a saved provider and shows the real result count', async () => {
    await act(async () => root!.render(<WebSearchModelEditor config={config} responsesAvailable onSaved={vi.fn()} onNotice={vi.fn()} />));
    await act(async () => (container!.querySelector('[aria-label="测试豆包"]') as HTMLButtonElement).click());

    expect(api.testWebSearch).toHaveBeenCalledWith('doubao', 'OpenAI');
    expect(container!.textContent).toContain('2 条结果');
  });
});
