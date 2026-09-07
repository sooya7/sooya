// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoStudio, type VideoTask } from './VideoStudio.js';

const api = vi.hoisted(() => ({
  adminRequest: vi.fn()
}));

vi.mock('../lib/admin.js', () => ({ adminRequest: api.adminRequest }));
vi.mock('../lib/useAuthenticatedMedia.js', () => ({
  useAuthenticatedMedia: () => ({ url: 'blob:video', error: null, loading: false, retriable: false, retry: () => undefined })
}));

const finished: VideoTask = {
  id: 'vid_1', mode: 'text', prompt: '海边日落', status: 'succeeded', progress: 100, provider: 'openai-videos', model: 'sora-2',
  params: {}, sourceMedia: null, media: { id: 'media_1', url: '/api/media/media_1', mime: 'video/mp4', bytes: 1024 }, error: null,
  createdAt: '2026-09-08T00:00:00.000Z', completedAt: '2026-09-08T00:01:00.000Z'
};
const running: VideoTask = { ...finished, id: 'vid_2', mode: 'image', status: 'running', progress: 40, media: null, completedAt: null, prompt: '让画面动起来' };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  api.adminRequest.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('VideoStudio', () => {
  it('lists tasks with their state, plays finished videos and offers cancel for active ones', async () => {
    api.adminRequest.mockResolvedValue({ tasks: [running, finished], total: 2, active: 1 });
    await act(async () => root!.render(<VideoStudio onNotice={vi.fn()} />));

    expect(api.adminRequest).toHaveBeenCalledWith('/api/admin/video/generations?limit=20');
    const text = container!.textContent ?? '';
    expect(text).toContain('生成中 · 40%');
    expect(text).toContain('图生视频');
    expect(text).toContain('已完成');
    expect(container!.querySelector('video')?.getAttribute('src')).toBe('blob:video');
    const buttons = [...container!.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('取消');
    expect(buttons).toContain('删除记录');
  });

  it('submits a multipart request with the prompt, optional duration and image', async () => {
    api.adminRequest.mockImplementation(async (_path: string, options?: { method?: string; body?: FormData }) => {
      if (options?.method === 'POST') return { task: { ...finished, id: 'vid_new', status: 'queued', progress: null, media: null, prompt: '云在流动' } };
      return { tasks: [], total: 0, active: 0 };
    });
    const onNotice = vi.fn();
    await act(async () => root!.render(<VideoStudio onNotice={onNotice} />));

    const textarea = container!.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '云在流动');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (container!.querySelector('[data-testid="admin-video-submit"]') as HTMLButtonElement).click(); });

    const post = api.adminRequest.mock.calls.find(([, options]) => (options as { method?: string } | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/api/admin/video/generations');
    const form = (post?.[1] as { body: FormData }).body;
    expect(form.get('prompt')).toBe('云在流动');
    expect(form.has('image')).toBe(false);
    expect(onNotice).toHaveBeenCalledWith('文生视频任务已提交');
    expect(container!.textContent).toContain('排队中');
  });

  it('refuses to submit an empty prompt without calling the API', async () => {
    api.adminRequest.mockResolvedValue({ tasks: [], total: 0, active: 0 });
    const onNotice = vi.fn();
    await act(async () => root!.render(<VideoStudio onNotice={onNotice} />));
    await act(async () => { (container!.querySelector('[data-testid="admin-video-submit"]') as HTMLButtonElement).click(); });
    expect(onNotice).toHaveBeenCalledWith('先写一句视频描述');
    expect(api.adminRequest.mock.calls.filter(([, options]) => (options as { method?: string } | undefined)?.method === 'POST')).toHaveLength(0);
  });

  it('shows the chat policy from the overview and saves it through PUT /api/admin/video', async () => {
    api.adminRequest.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
      if (path === '/api/admin/video' && options?.method === 'PUT') return { policy: { ...(options.body as { policy: Record<string, unknown> }).policy, enabled: true, frequency: 'never' } };
      if (path === '/api/admin/video') return { policy: { enabled: true, frequency: 'never', maxPerDay: 3 } };
      return { tasks: [], total: 0, active: 0 };
    });
    const onNotice = vi.fn();
    await act(async () => root!.render(<VideoStudio onNotice={onNotice} />));

    const section = container!.querySelector('[data-testid="admin-video-policy"]')!;
    expect(section.textContent).toContain('聊天里的视频');
    const cap = section.querySelector('input[type="number"]') as HTMLInputElement;
    expect(cap.value).toBe('3');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(cap, '5');
      cap.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (container!.querySelector('[data-testid="admin-video-policy-save"]') as HTMLButtonElement).click(); });

    const put = api.adminRequest.mock.calls.find(([path, options]) => path === '/api/admin/video' && (options as { method?: string } | undefined)?.method === 'PUT');
    expect((put?.[1] as { body: { policy: { maxPerDay: number } } }).body.policy.maxPerDay).toBe(5);
    expect(onNotice).toHaveBeenCalledWith('聊天里的视频策略已保存');
  });
});
