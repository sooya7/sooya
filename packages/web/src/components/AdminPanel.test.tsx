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
});
