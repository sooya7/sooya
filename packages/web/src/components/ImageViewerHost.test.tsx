// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageViewerHost } from './ImageViewerHost.js';

/**
 * 图片 blob 还没加载完时，`.image-part` 按钮的 data-src 是空的，host 扫描时会把它
 * 滤掉 —— 但按钮仍然能点。open 事件带着一个不在列表里的 id 到来，findIndex 返回 -1，
 * Math.max(0, -1) 把它变成 0：查看器打开并显示列表里的第一张图，用户还以为自己
 * 点的就是它。找不到目标时宁可不打开，也不能落到第一张。
 */

function imageButton(id: string, src: string): void {
  const button = document.createElement('button');
  button.className = 'image-part';
  button.dataset.mediaId = id;
  button.dataset.src = src;
  button.dataset.alt = `图 ${id}`;
  document.body.appendChild(button);
}

let root: Root | null = null;
let container: HTMLElement;

const viewer = () => document.querySelector('[role="dialog"][aria-label="图片查看器"]');
const currentSrc = () => document.querySelector('.image-viewer-current')?.getAttribute('src');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  container.remove();
  document.querySelectorAll('.image-part').forEach((el) => el.remove());
});

async function openImage(id: string): Promise<void> {
  await act(async () => { window.dispatchEvent(new CustomEvent('sooya:open-image', { detail: { id } })); });
}

describe('ImageViewerHost 打开目标', () => {
  it('点一张还没加载完的图，不会错误打开列表里的第一张', async () => {
    imageButton('a', 'blob:a');
    imageButton('b', '');
    await act(async () => { root!.render(<ImageViewerHost />); });

    await openImage('b');

    expect(viewer()).toBeNull();
  });

  it('加载完成的图照常在自己的位置打开', async () => {
    imageButton('a', 'blob:a');
    imageButton('b', 'blob:b');
    await act(async () => { root!.render(<ImageViewerHost />); });

    await openImage('b');

    expect(viewer()).not.toBeNull();
    expect(currentSrc()).toBe('blob:b');
  });
});
