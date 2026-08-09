// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPanel from './AdminPanel.js';

const adminMocks = vi.hoisted(() => ({
  system: vi.fn(() => new Promise<never>(() => {})),
  capabilities: vi.fn(async () => ({ capabilities: {} })),
  backups: vi.fn(async () => ({ backups: [] })),
  persona: vi.fn(async () => ({
    persona: {
      id: 'persona_sooya',
      name: 'SOOYA',
      avatar: '/api/media/avatar_sooya',
      userAvatar: '/api/media/avatar_user',
      tagline: '在的',
      systemPrompt: '',
      language: 'zh-CN',
      stickerPolicy: {},
      voicePolicy: {},
      imagePolicy: {}
    }
  })),
  memories: vi.fn(async () => ({
    memories: [],
    recall: {
      query: '猫', strategy: 'fts', fallbackReason: null,
      stats: { recalled: 1, included: 0, deduplicated: 1, budgetDropped: 0 },
      entries: [{ id: 'm1', kind: 'fact', content: '喜欢猫', sources: [], strategy: 'fts', score: null, reason: 'FTS lexical match', included: false, droppedReason: 'deduplicated_recent' }]
    }
  })),
  stickers: vi.fn(async () => ({ stickers: [] })),
  media: vi.fn(async () => ({ media: [] })),
  models: vi.fn(async () => ({
    models: {
      storageVersion: 2,
      chat: { provider: 'openai-responses', model: 'deepseek-chat', supportsTools: true, apiKeyConfigured: true },
      webSearch: {
        enabled: true,
        providers: ['doubao', 'tavily', 'responses'],
        maxResults: 5,
        timeoutMs: 15000,
        doubao: { edition: 'custom', baseUrl: 'https://open.feedcoopapi.com/search_api/web_search', apiKeyConfigured: true },
        tavily: { baseUrl: 'https://api.tavily.com/search', apiKeyConfigured: true }
      }
    }
  })),
  updateModels: vi.fn(async (patch: Record<string, unknown>) => ({ models: patch })),
  modelPresets: vi.fn(async () => ({ presets: [], slots: [] })),
  saveModelPresets: vi.fn(async () => ({ presets: [] })),
  applyModelPreset: vi.fn(async () => ({ applied: 'chat', models: {} })),
  discoverModels: vi.fn(async () => ({ models: [], source: 'test' })),
  testModel: vi.fn(async () => ({ ok: true, provider: 'test', latencyMs: 1, detail: 'ok' })),
  testWebSearch: vi.fn(async (provider: string) => ({ ok: true, provider, latencyMs: 1, resultCount: 1 })),
}));

vi.mock('../lib/admin.js', () => ({
  ADMIN_UNAUTHORIZED_EVENT: 'sooya:admin-unauthorized',
  adminApi: adminMocks,
  getAdminToken: () => 'admin-token',
  setAdminToken: vi.fn(),
  clearAdminToken: vi.fn()
}));

vi.mock('../lib/useAuthenticatedMedia.js', () => ({
  useAuthenticatedMedia: (path: string | null | undefined) => ({
    url: path ? `blob:preview/${encodeURIComponent(path)}` : null,
    error: null,
    loading: false,
    retriable: false,
    retry: vi.fn()
  })
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/avatar');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  });
  adminMocks.system.mockClear();
  adminMocks.capabilities.mockClear();
  adminMocks.backups.mockClear();
  adminMocks.persona.mockClear();
  adminMocks.memories.mockClear();
  adminMocks.stickers.mockClear();
  adminMocks.media.mockClear();
  adminMocks.models.mockClear();
  adminMocks.updateModels.mockClear();
  adminMocks.modelPresets.mockClear();
  adminMocks.testWebSearch.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  window.history.replaceState(null, '', '/');
});

describe('AdminPanel 子页首屏', () => {
  it('打开头像页时不等待无关的概览请求', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<AdminPanel initialTab="avatar" />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="admin-dashboard"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="avatar-settings"]')).not.toBeNull();
    expect(adminMocks.persona).toHaveBeenCalledTimes(1);
    expect(adminMocks.system).not.toHaveBeenCalled();
    expect(adminMocks.capabilities).not.toHaveBeenCalled();
    expect(adminMocks.backups).not.toHaveBeenCalled();
  });

  it('子页接口报告鉴权失效后回到令牌输入页', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<AdminPanel initialTab="avatar" />);
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new Event('sooya:admin-unauthorized'));
    });

    expect(container.querySelector('[data-testid="admin-lock"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="admin-dashboard"]')).toBeNull();
  });

  it('内容页把召回策略、匹配依据和丢弃原因显示为中文', async () => {
    window.history.replaceState(null, '', '/admin/content');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<AdminPanel initialTab="content" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const recall = container.querySelector('[data-testid="admin-memory-recall"]')!;
    expect(recall.textContent).toContain('关键词检索');
    expect(recall.textContent).toContain('与近期对话重复');
    expect(recall.textContent).toContain('关键词匹配');
    expect(recall.textContent).not.toContain('deduplicated_recent');
    expect(recall.textContent).not.toContain('FTS lexical match');
  });

  it('联网搜索位于现有模型配置的能力列表中', async () => {
    window.history.replaceState(null, '', '/admin/models');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminPanel initialTab="models" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('联网搜索'));
    expect(button).toBeTruthy();
    await act(async () => button!.click());

    expect(container.querySelector('[data-testid="admin-web-search-editor"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="admin-dashboard"]')).toHaveLength(1);
  });
});
