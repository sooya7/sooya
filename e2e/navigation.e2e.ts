import { expect, test, type Locator, type Page } from '@playwright/test';

const CHAT_TOKEN = 'e2e-chat-token';
const ADMIN_TOKEN = 'e2e-admin-token';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ chat, admin }) => {
    localStorage.setItem('sooya.token', chat);
    localStorage.setItem('sooya.admin-token', admin);
  }, { chat: CHAT_TOKEN, admin: ADMIN_TOKEN });
});

/**
 * 等待页面滚动位置、内容高度与渲染消息数在 windowMs 内保持稳定。
 *
 * 聊天页打开后 SSE 回复管道与虚拟列表的「估算 → 实测」测量级联会持续改变列表
 * 高度，基线采集必须等它结束（或至少等一个长间隙），否则 before/after 两个
 * 滚动量对应的是不同状态的列表，差值没有可比性。
 */
async function waitPageStable(page: Page, scroller: Locator, windowMs = 1500): Promise<void> {
  let lastKey = '';
  let stableMs = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const key = await scroller.evaluate((element) => `${element.scrollTop}|${element.scrollHeight}|${element.querySelectorAll('[data-testid="message"]').length}`);
    if (key === lastKey) {
      stableMs += 100;
      if (stableMs >= windowMs) return;
    } else {
      lastKey = key;
      stableMs = 0;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('scroll position did not settle');
}

/** 视口顶部第一条可见消息 + 顶边偏移（与 App 的锚点捕获同源）。 */
async function captureAnchor(scroller: Locator): Promise<{ messageId: string; offset: number } | null> {
  return scroller.evaluate((element) => {
    const scrollerTop = element.getBoundingClientRect().top;
    for (const row of Array.from(element.querySelectorAll('[data-message-id]'))) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom > scrollerTop) {
        return { messageId: row.getAttribute('data-message-id') ?? '', offset: Math.round(rect.top - scrollerTop) };
      }
    }
    return null;
  });
}

test('chat session survives admin navigation and browser history', async ({ page }) => {
  let bootstraps = 0;
  let streams = 0;
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/bootstrap') bootstraps += 1;
    if (pathname === '/api/stream') streams += 1;
  });

  await page.goto('/');
  await expect(page.getByTestId('connection-status')).toContainText('在线');
  await page.getByTestId('admin-entry').click();
  await expect(page.getByTestId('admin-dashboard')).toBeVisible();
  await page.getByTestId('admin-return-chat').first().click();
  await expect(page.getByTestId('scroller')).toBeVisible();
  expect(bootstraps).toBe(1);
  expect(streams).toBe(1);

  await page.goBack();
  await expect(page.getByTestId('admin-dashboard')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('scroller')).toBeVisible();
  expect(bootstraps).toBe(1);
  expect(streams).toBe(1);
});

test('returning to chat restores a history-reading scroll position', async ({ page, request }) => {
  for (let index = 0; index < 20; index += 1) {
    const response = await request.post('/api/messages/sync', {
      headers: { 'x-sooya-token': CHAT_TOKEN },
      data: {
        clientMsgId: `route-scroll-${index}-${Date.now()}`,
        content: [{ type: 'text', text: `路由滚动 ${index}` }]
      }
    });
    expect(response.ok()).toBeTruthy();
  }

  await page.goto('/');
  const scroller = page.getByTestId('scroller');
  await expect(page.locator('[data-testid="message"]').first()).toBeVisible();
  // 等 SSE 回复管道与测量级联结束，基线才可复现。
  await waitPageStable(page, scroller);

  // 读历史位置选在加载哨兵上边距（120px）之外：避免触发 loadOlder 的前置消息
  // 滚动补偿，基线保持确定。
  await scroller.evaluate((element) => { element.scrollTop = 300; });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await waitPageStable(page, scroller);
  // 页面残留滚动机制（若触发了 loadOlder 补偿）可能把位置冲走，安静后再设一次并复验。
  await scroller.evaluate((element) => { element.scrollTop = 300; });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await waitPageStable(page, scroller, 800);
  const before = await scroller.evaluate((element) => element.scrollTop);
  const beforeAnchor = await captureAnchor(scroller);

  await page.getByTestId('admin-entry').click();
  await expect(page.getByTestId('admin-dashboard')).toBeVisible();
  await page.getByTestId('admin-return-chat').first().click();
  await expect(scroller).toBeVisible();
  await waitPageStable(page, scroller);
  const after = await scroller.evaluate((element) => element.scrollTop);
  const afterAnchor = await captureAnchor(scroller);

  expect(Math.abs(after - before)).toBeLessThan(60);
  // 锚点模型契约：视口顶部的同一消息回到原偏移（App 侧结构性修复的直接验证）。
  expect(afterAnchor?.messageId).toBe(beforeAnchor?.messageId);
  expect(Math.abs((afterAnchor?.offset ?? 0) - (beforeAnchor?.offset ?? 0))).toBeLessThan(60);
});
