// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoNotice } from './autoNotice.js';

/**
 * 管理面板的 SectionNotice 一旦 set 就永远挂在页面上，「人设已保存」能一直留到
 * 下次导航。聊天页的通知 5 秒自动消失（App.tsx），管理面板也该一样。
 */

let count = 0;
function Probe() {
  const [notice, setNotice] = useAutoNotice();
  return (
    <button type="button" onClick={() => { count += 1; setNotice(`通知 ${count}`); }}>
      {notice ?? '无通知'}
    </button>
  );
}

let root: Root | null = null;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  count = 0;
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
  vi.useRealTimers();
});

describe('useAutoNotice', () => {
  it('通知 5 秒后自动消失', async () => {
    await act(async () => { root!.render(<Probe />); });
    const button = container.querySelector('button')!;

    await act(async () => { button.click(); });
    expect(container.textContent).toContain('通知 1');

    await act(async () => { vi.advanceTimersByTime(5100); });
    expect(container.textContent).toContain('无通知');
  });

  it('新通知重置计时，不会沿用旧通知的倒计时', async () => {
    await act(async () => { root!.render(<Probe />); });
    const button = container.querySelector('button')!;

    await act(async () => { button.click(); });
    await act(async () => { vi.advanceTimersByTime(4000); });
    await act(async () => { button.click(); });

    // 距第一条 8 秒、距第二条 4 秒：第二条还在
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(container.textContent).toContain('通知 2');

    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(container.textContent).toContain('无通知');
  });
});
