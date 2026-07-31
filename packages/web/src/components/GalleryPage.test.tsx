// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gallery downloaded every full-size original with `await Promise.all(...)` before
 * it set any state, which produced two user-visible failures that no test covered:
 * the grid stayed empty and the header read "共 0 个媒体记录" until the last of tens of
 * megabytes had transferred (over 24s in production), and a single unreadable image
 * rejected the batch and blanked a gallery whose other items were fine.
 *
 * These tests hold the blob loader open on purpose so "before the images arrive" is an
 * observable state rather than a race.
 */

const gallery = vi.fn();
const fetchAuthenticatedMedia = vi.fn();
const mediaThumbnailPath = vi.fn((path: string, width: number) => `${path}?w=${width}`);
const useAuthenticatedMedia = vi.fn();

vi.mock('../lib/features.js', () => ({
  featureApi: {
    gallery: (...args: unknown[]) => gallery(...args),
    patchMedia: vi.fn(),
    galleryBatch: vi.fn()
  },
  adminMediaUrl: (url: string) => url
}));

vi.mock('../lib/admin.js', () => ({
  getAdminToken: () => 'admin-secret',
  setAdminToken: vi.fn(),
  clearAdminToken: vi.fn()
}));

vi.mock('../lib/authenticatedMedia.js', () => ({
  fetchAuthenticatedMedia: (...args: unknown[]) => fetchAuthenticatedMedia(...args),
  mediaThumbnailPath: (...args: unknown[]) => mediaThumbnailPath(...(args as [string, number])),
  releaseMediaUrl: vi.fn(),
  blobForMediaUrl: () => null,
  safeDownloadName: (name: string) => name
}));

vi.mock('../lib/useAuthenticatedMedia.js', () => ({
  useAuthenticatedMedia: (...args: unknown[]) => useAuthenticatedMedia(...args)
}));

let GalleryPage: typeof import('./GalleryPage.js').default;
let container: HTMLDivElement;
let root: Root;

function item(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'image',
    mime: 'image/png',
    bytes: 2_100_000,
    url: `/api/media/${id}`,
    name: `${id}.png`,
    origin: 'generated',
    exists: true,
    createdAt: '2026-07-30T00:00:00.000Z',
    ...extra
  };
}

/** A blob load we can resolve or reject by hand, one deferred per media id. */
function deferredLoader() {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  fetchAuthenticatedMedia.mockImplementation(
    (path: string) =>
      new Promise((resolve, reject) => {
        // 网格现在请求的是 `?w=` 缩略图路径，按 id 归拢时去掉查询串。
        const id = (path.split('/').pop() as string).split('?')[0] as string;
        pending.set(id, { resolve, reject });
      })
  );
  return {
    async settle(id: string, ok = true) {
      const d = pending.get(id);
      if (!d) throw new Error(`no pending load for ${id}`);
      await act(async () => {
        if (ok) d.resolve({ url: `blob:${id}`, blob: new Blob(['x']), contentType: 'image/png' });
        else d.reject(new Error('媒体内容读取失败'));
      });
    },
    get size() {
      return pending.size;
    }
  };
}

const text = () => container.textContent ?? '';
const thumbs = () => [...container.querySelectorAll('.gallery-item')].map((el) => el.getAttribute('data-media-id'));

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthenticatedMedia.mockReturnValue({ url: null, error: null, loading: false, retriable: false, retry: vi.fn() });
  ({ default: GalleryPage } = await import('./GalleryPage.js'));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(items: ReturnType<typeof item>[], total = items.length) {
  gallery.mockResolvedValue({ media: items, stats: { count: items.length, bytes: 14_400_000 }, total });
  await act(async () => {
    root.render(<GalleryPage />);
  });
}

describe('GalleryPage 渐进加载', () => {
  it('图片还没到就先显示总数，不再谎报 0 个媒体记录', async () => {
    const loader = deferredLoader();
    await mount([item('a'), item('b')], 255);

    // 此刻两张图的 blob 都还挂着
    expect(loader.size).toBe(2);
    expect(thumbs()).toEqual([]);
    expect(text()).toContain('255');
    expect(text()).not.toContain('共 0 个媒体记录');
  });

  it('每张图各自到达就各自出现，不必等最慢的那张', async () => {
    const loader = deferredLoader();
    await mount([item('a'), item('b'), item('c')]);

    await loader.settle('b');
    expect(thumbs()).toEqual(['b']);

    await loader.settle('a');
    // 服务端顺序是 a,b,c —— 即使 b 先到，a 也要排回前面
    expect(thumbs()).toEqual(['a', 'b']);

    await loader.settle('c');
    expect(thumbs()).toEqual(['a', 'b', 'c']);
  });

  it('一张坏图不再让整个图库变空', async () => {
    const loader = deferredLoader();
    await mount([item('a'), item('b'), item('c')]);

    await loader.settle('a');
    await loader.settle('b', false);
    await loader.settle('c');

    expect(thumbs()).toEqual(['a', 'c']);
    expect(text()).toContain('1 张图片加载失败');
  });

  it('全部失败时报告失败数量而不是静默空白', async () => {
    const loader = deferredLoader();
    await mount([item('a'), item('b')]);

    await loader.settle('a', false);
    await loader.settle('b', false);

    expect(thumbs()).toEqual([]);
    expect(text()).toContain('2 张图片加载失败');
  });

  it('不存在的媒体不触发 blob 请求也不算失败', async () => {
    const loader = deferredLoader();
    await mount([item('a'), item('gone', { exists: false })]);

    // 只有 a 需要 blob
    expect(loader.size).toBe(1);
    await loader.settle('a');
    expect(text()).not.toContain('加载失败');
  });
});

describe('GalleryPage 代次守卫', () => {
  /**
   * load(false) 之间没有任何串行化：切筛选发起新加载后，旧加载的迟到响应照样
   * setMedia([]) 再逐张发布，把新筛选的结果冲掉。全量加载必须带代次，迟到的旧
   * 代次响应直接作废。
   */
  it('旧筛选迟到的响应不覆盖新筛选的结果', async () => {
    const loader = deferredLoader();
    const pending: Array<(value: unknown) => void> = [];
    gallery.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));

    await act(async () => { root.render(<GalleryPage />); });
    expect(gallery).toHaveBeenCalledTimes(1);

    // 打开回收站，触发第二次全量加载（新筛选）
    const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === '打开回收站')!;
    await act(async () => { toggle.click(); });
    expect(gallery).toHaveBeenCalledTimes(2);

    // 新筛选先回来
    await act(async () => {
      pending[1]!({ media: [item('fresh')], stats: { count: 1, bytes: 2_100_000 }, total: 1 });
    });
    await loader.settle('fresh');
    expect(thumbs()).toEqual(['fresh']);

    // 旧筛选姗姗来迟：不得清空、不得覆盖、也不再为旧结果发 blob 请求
    await act(async () => {
      pending[0]!({ media: [item('stale')], stats: { count: 9, bytes: 9 }, total: 9 });
    });
    expect(thumbs()).toEqual(['fresh']);
    expect(loader.size).toBe(1);
    expect(text()).toContain('1 张');
  });
});

describe('GalleryPage 缩略图', () => {
  /**
   * 网格以前对每项都拉原图（一页 60 张，几十 MB）。现在网格拿 `?w=` 缩略图，
   * 大图查看器与「保存」仍按原图路径（不带 w）单独取。
   */
  it('网格请求带 w 的缩略图，不再拉原图', async () => {
    const loader = deferredLoader();
    await mount([item('a'), item('b')]);

    const paths = fetchAuthenticatedMedia.mock.calls.map((call) => call[0] as string);
    expect(paths).toEqual([
      expect.stringMatching(/^\/api\/media\/a\?w=\d+$/),
      expect.stringMatching(/^\/api\/media\/b\?w=\d+$/)
    ]);
    expect(mediaThumbnailPath).toHaveBeenCalledWith('/api/media/a', expect.any(Number));
    await loader.settle('a');
    await loader.settle('b');
  });

  it('大图查看器单独取原图（不带 w），拿到前先显示缩略图', async () => {
    const loader = deferredLoader();
    await mount([item('a')]);
    await loader.settle('a');

    const thumb = container.querySelector('.gallery-thumb') as HTMLButtonElement;
    await act(async () => { thumb.click(); });

    // 查看器按原图路径（无 w）单独取一份
    expect(useAuthenticatedMedia).toHaveBeenCalledWith('/api/media/a', 'admin', 'image');
    // 原图还没到：先显示网格那份缩略图 blob，点开是即时的
    expect(container.querySelector('.image-viewer-current')?.getAttribute('src')).toBe('blob:a');
  });

  it('原图到达后查看器同一位置换成原图', async () => {
    const loader = deferredLoader();
    useAuthenticatedMedia.mockImplementation((path: string | null) => ({
      url: path === '/api/media/a' ? 'blob:original-a' : null,
      error: null,
      loading: false,
      retriable: false,
      retry: vi.fn()
    }));
    await mount([item('a')]);
    await loader.settle('a');

    const thumb = container.querySelector('.gallery-thumb') as HTMLButtonElement;
    await act(async () => { thumb.click(); });

    expect(container.querySelector('.image-viewer-current')?.getAttribute('src')).toBe('blob:original-a');
  });

  it('「保存」仍取原图（不带 w）', async () => {
    const loader = deferredLoader();
    await mount([item('a')]);
    await loader.settle('a');

    const save = [...container.querySelectorAll<HTMLButtonElement>('.gallery-item button')].find((button) => button.textContent === '保存')!;
    await act(async () => { save.click(); });

    const paths = fetchAuthenticatedMedia.mock.calls.map((call) => call[0] as string);
    expect(paths).toContainEqual('/api/media/a');
  });
});
