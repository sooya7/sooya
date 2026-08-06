import { expect, test } from '@playwright/test';

const CHAT_TOKEN = 'e2e-chat-token';
const ADMIN_TOKEN = 'e2e-admin-token';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ chat, admin }) => {
    localStorage.setItem('sooya.token', chat);
    localStorage.setItem('sooya.admin-token', admin);
  }, { chat: CHAT_TOKEN, admin: ADMIN_TOKEN });
});

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
  await scroller.evaluate((element) => { element.scrollTop = 40; });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const before = await scroller.evaluate((element) => element.scrollTop);

  await page.getByTestId('admin-entry').click();
  await expect(page.getByTestId('admin-dashboard')).toBeVisible();
  await page.getByTestId('admin-return-chat').first().click();
  await expect(scroller).toBeVisible();
  const after = await scroller.evaluate((element) => element.scrollTop);

  expect(Math.abs(after - before)).toBeLessThan(60);
});
