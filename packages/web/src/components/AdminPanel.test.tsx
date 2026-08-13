// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminPanel from './AdminPanel.js';

const adminMocks = vi.hoisted(() => ({
  system: vi.fn(() => new Promise<never>(() => {})),
  capabilities: vi.fn(async () => ({ capabilities: {} })),
  backups: vi.fn(async () => ({ backups: [] })),
  voiceBehavior: vi.fn(async () => ({ enabled: true, maxVoiceSeconds: 35 })),
  updateVoiceBehavior: vi.fn(async (patch: Record<string, unknown>) => ({ enabled: true, maxVoiceSeconds: 35, ...patch })),
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
  mcpOverview: vi.fn(async () => ({ configSource: 'test', globalPolicy: { readEnabled: true, writeEnabled: false, maintenanceEnabled: true }, servers: [], tools: [], memory: { backend: 'ombre', connection: 'degraded', health: null, lastCommit: null, pending: 0, uncertain: 0, lastDream: null, dashboardUrl: null }, dashboardUrl: null })),
  ombreStatus: vi.fn(async () => ({ backend: 'ombre', connection: 'degraded', health: null, lastCommit: null, pending: 0, uncertain: 0, lastDream: null, dashboardUrl: null })),
  ombreActivity: vi.fn(async () => ({ activity: [] })),
  legacyMemories: vi.fn(async () => ({ memories: [], total: 0, readOnly: true })),
  adminStickers: vi.fn(async () => ({ stickers: [], total: 0, offset: 0, facets: { status: {}, source: {}, emotion: {} } })),
  adminMedia: vi.fn(async () => ({ media: [], total: 0, offset: 0 })),
  chatHistory: vi.fn(async () => ({ messages: [], total: 0, limit: 40, offset: 0 })),
  models: vi.fn(async () => ({
    models: {
      storageVersion: 2,
      chat: { provider: 'openai-responses', model: 'deepseek-chat', supportsTools: true, apiKeyConfigured: true },
      tts: { provider: 'fish', model: 's2.1-pro-free', referenceId: 'sooya-voice', apiKeyConfigured: true },
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
  addModelPreset: vi.fn(async (preset: Record<string, unknown>) => ({ preset: { ...preset, apiKeyConfigured: true } })),
  applyModelPreset: vi.fn(async () => ({ applied: 'chat', models: {} })),
  discoverModels: vi.fn(async () => ({ models: [], source: 'test' })),
  testModel: vi.fn(async () => ({ ok: true, provider: 'test', latencyMs: 1, detail: 'ok' })),
  testWebSearch: vi.fn(async (provider: string) => ({ ok: true, provider, latencyMs: 1, resultCount: 1 })),
  uploadSticker: vi.fn(async () => ({ created: [], failed: [] })),
  analyzeStickerBatch: vi.fn(async () => ({ queued: 0, skipped: 0 })),
  errors: vi.fn(async () => ({ errors: [
    { id: 'e1', createdAt: '2026-08-12T04:55:00.000Z', scope: 'job.sticker.analyze', message: 'invalid_analysis_json', detail: { raw: 'bad' } },
    { id: 'e2', createdAt: '2026-08-12T04:54:00.000Z', scope: 'job.sticker.analyze', message: 'invalid_analysis_json: schema', detail: null }
  ] })),
  jobs: vi.fn(async () => ({ jobs: [
    { id: 'j1', type: 'life.tick', status: 'completed', attempts: 1, max_attempts: 3, last_error: null, created_at: '2026-08-12T04:00:00.000Z', updated_at: '2026-08-12T04:00:01.000Z' },
    { id: 'j2', type: 'life.tick', status: 'completed', attempts: 1, max_attempts: 3, last_error: null, created_at: '2026-08-12T04:05:00.000Z', updated_at: '2026-08-12T04:05:01.000Z' }
  ] })),
  clearErrors: vi.fn(async () => ({ ok: true })),
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
  adminMocks.voiceBehavior.mockClear();
  adminMocks.updateVoiceBehavior.mockClear();
  adminMocks.modelPresets.mockClear();
  adminMocks.addModelPreset.mockClear();
  adminMocks.testWebSearch.mockClear();
  adminMocks.mcpOverview.mockClear();
  adminMocks.ombreStatus.mockClear();
  adminMocks.ombreActivity.mockClear();
  adminMocks.legacyMemories.mockClear();
  adminMocks.adminStickers.mockClear();
  adminMocks.adminMedia.mockClear();
  adminMocks.chatHistory.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  window.history.replaceState(null, '', '/');
});

describe('AdminPanel 子页首屏', () => {
  it('renders the independent MCP route without exposing schemas in the list', async () => {
    window.history.replaceState(null, '', '/admin/mcp');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminPanel initialTab="mcp" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="admin-mcp-page"]')).not.toBeNull();
    expect(adminMocks.mcpOverview).toHaveBeenCalledTimes(1);
  });

  it('uses content subroutes and loads only the selected content page', async () => {
    window.history.replaceState(null, '', '/admin/content/chat');
    adminMocks.chatHistory.mockImplementationOnce(async () => ({
      messages: [{
        id: 'chat-1', conversationId: 'main', role: 'user', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z', seq: 1, status: 'sent',
        content: [{ id: 'part-1', type: 'text', text: 'test chat' }]
      }],
      total: 1,
      limit: 40,
      offset: 0
    } as never));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminPanel initialTab="content" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="admin-content-management"]')).not.toBeNull();
    await vi.waitFor(() => expect(adminMocks.chatHistory).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(container!.querySelector('[data-testid="admin-chat-history"]')).not.toBeNull());
    expect(adminMocks.ombreStatus).not.toHaveBeenCalled();
    expect(adminMocks.adminStickers).not.toHaveBeenCalled();
  });

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

  it('运维页按人话问题类型和任务状态聚合日志', async () => {
    window.history.replaceState(null, '', '/admin/operations');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminPanel initialTab="operations" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const errors = container.querySelector('[data-testid="admin-error-list"]')!;
    expect(errors.textContent).toContain('表情包 AI 分析结果格式异常');
    expect(errors.textContent).toContain('1 类 · 2 次');
    const summary = errors.querySelector('.admin-error-summary')!;
    expect(summary.textContent).not.toContain('invalid_analysis_json');
    expect(errors.querySelector('.admin-error-group')?.hasAttribute('open')).toBe(false);

    const jobs = container.querySelector('[data-testid="admin-job-list"]')!;
    expect(jobs.textContent).toContain('生活状态更新');
    expect(jobs.textContent).toContain('已完成');
    expect(jobs.textContent).toContain('2 个');
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

  it('存入模型库走服务器绑定接口，并且未保存的新 key 不会被存入', async () => {
    window.history.replaceState(null, '', '/admin/models');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminPanel initialTab="models" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const key = container.querySelector('[data-testid="admin-model-apikey"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(key, 'unsaved-secret');
      key.dispatchEvent(new Event('input', { bubbles: true }));
      key.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const add = container.querySelector('[data-testid="admin-model-add-preset"]') as HTMLButtonElement;
    await act(async () => { add.click(); await Promise.resolve(); });

    expect(adminMocks.addModelPreset).not.toHaveBeenCalled();
    expect(adminMocks.saveModelPresets).not.toHaveBeenCalled();
    expect(container.textContent).toContain('请先点击“保存模型配置”，再存入模型库');
  });

  it('语音收敛后导航不再出现「情绪语音」页', async () => {
    window.history.replaceState(null, '', '/admin/overview');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminPanel initialTab="overview" />);
      await Promise.resolve();
    });

    const tabs = [...container.querySelectorAll('[data-testid^="admin-tab-"]')].map((item) => item.textContent ?? '');
    expect(tabs.some((text) => text.includes('情绪语音'))).toBe(false);
    expect(tabs.some((text) => text.includes('语音合成'))).toBe(false);
    // 旧路径 /admin/voice 回退到概览而不是渲染已删除的页。
    window.history.replaceState(null, '', '/admin/voice');
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(container.querySelector('[data-testid="voice-settings"]')).toBeNull();
  });

  it('助手配置显示最小「语音行为」开关并可保存', async () => {
    window.history.replaceState(null, '', '/admin/persona');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminPanel initialTab="persona" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const section = container.querySelector('[data-testid="voice-behavior-settings"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain('启用语音');
    expect(section!.textContent).toContain('单条语音最大长度');
    expect(adminMocks.voiceBehavior).toHaveBeenCalledTimes(1);

    const checkbox = section!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { checkbox.click(); });
    const saveButton = [...section!.querySelectorAll('button')].find((item) => item.textContent?.includes('保存语音行为'))!;
    await act(async () => { saveButton.click(); await Promise.resolve(); });
    expect(adminMocks.updateVoiceBehavior).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('模型配置 → 语音合成 补齐 Fish 参数并提供试听', async () => {
    window.history.replaceState(null, '', '/admin/models');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminPanel initialTab="models" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('语音合成模型'));
    expect(button).toBeTruthy();
    await act(async () => button!.click());

    // Fish 专属参数齐全（收敛 §3.3 补齐列表）。
    const text = container.textContent ?? '';
    expect(text).toContain('Reference-Id');
    expect(text).toContain('Top-P');
    expect(text).toContain('normalizeLoudness');
    expect(text).toContain('repetitionPenalty');
    expect(text).toContain('conditionOnPreviousChunks');
    // 试听区存在且可点击（URL 保持 /api/admin/voice/preview）。
    const preview = container.querySelector('[data-testid="admin-tts-preview"]');
    expect(preview).not.toBeNull();
    const play = preview!.querySelector('[data-testid="admin-tts-preview-play"]') as HTMLButtonElement;
    expect(play).not.toBeNull();
  });
});
