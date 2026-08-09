// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminPersona } from '../lib/admin.js';
import { AvatarEditor, emotionLabel } from './FeatureAdminPage.js';

const mediaMock = vi.hoisted(() => ({
  paths: [] as string[],
  state: { url: null as string | null, error: null as string | null, loading: true, retriable: false },
  retry: vi.fn()
}));

vi.mock('../lib/useAuthenticatedMedia.js', () => ({
  useAuthenticatedMedia: (path: string) => {
    mediaMock.paths.push(path);
    return { ...mediaMock.state, retry: mediaMock.retry };
  }
}));

const persona: AdminPersona = {
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
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mediaMock.paths.length = 0;
  mediaMock.state = { url: null, error: null, loading: true, retriable: false };
  mediaMock.retry.mockClear();
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('AvatarEditor 渐进预览', () => {
  it('加载期间预留头像空间，不把空地址退化成页面根路径请求', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<AvatarEditor persona={persona} onPersona={() => {}} onNotice={() => {}} />);
    });

    expect(mediaMock.paths).toEqual([
      '/api/media/avatar_sooya?w=176',
      '/api/media/avatar_user?w=176'
    ]);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('.admin-avatar-preview-skeleton')).toHaveLength(2);
  });

  it('加载失败后显示明确占位和可操作的重试入口', async () => {
    mediaMock.state = { url: null, error: '媒体加载失败', loading: false, retriable: true };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<AvatarEditor persona={persona} onPersona={() => {}} onNotice={() => {}} />);
    });

    expect(container.querySelectorAll('.admin-avatar-preview-skeleton')).toHaveLength(0);
    expect(container.querySelectorAll('.admin-avatar-preview-placeholder')).toHaveLength(2);
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === '重试预览');
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(mediaMock.retry).toHaveBeenCalledTimes(1);
  });
});

describe('管理面板中文数据值', () => {
  it('翻译表情情绪', () => {
    expect(emotionLabel('neutral')).toBe('中性');
    expect(emotionLabel('sleepy')).toBe('困倦');
  });
});
