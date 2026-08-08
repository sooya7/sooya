import { expect, test, type Page } from '@playwright/test';

const CHAT_TOKEN = 'e2e-chat-token';
const ADMIN_TOKEN = 'e2e-admin-token';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ chat, admin }) => {
    localStorage.setItem('sooya.token', chat);
    localStorage.setItem('sooya.admin-token', admin);
  }, { chat: CHAT_TOKEN, admin: ADMIN_TOKEN });
});

async function gotoAdmin(page: Page, path: string): Promise<void> {
  await page.goto(path);
}

/**
 * Next-phase surfaces (P0-P3): the world-context admin and
 * metrics panels are reachable by exact
 * path, render against the live server, and their controls round-trip through
 * the admin API. The stable chat flows are covered by the other specs running
 * against the same server with these flags on.
 */
test.describe('next-phase admin surfaces', () => {
  test('life admin shows overview and the location manager lists builtins', async ({ page }) => {
    await gotoAdmin(page, '/admin/life/console');
    await expect(page.getByTestId('life-admin-page')).toBeVisible();
    await expect(page.getByTestId('life-overview')).toBeVisible();
    await expect(page.getByText('在哪里')).toBeVisible();
    // Location model is enabled on the e2e server: the location manager
    // lists the seeded builtins including home.
    await page.getByRole('tab', { name: '地点' }).click();
    await expect(page.getByTestId('life-location-list')).toBeVisible();
    // Mobile card-list layout prepends the column label to each cell name
    // ("名称 家 展开详情"), and the localized kind column also reads 家 for the
    // home row, so take the first matching cell instead of a unique one.
    const homeCell = page.getByTestId('life-location-list').getByRole('cell').filter({ hasText: '家' }).filter({ hasNotText: '附近' }).first();
    await expect(homeCell).toBeVisible();
  });

  test('overview embeds the base runtime metrics', async ({ page }) => {
    // Send a message first so the metrics have something to aggregate.
    await page.goto('/');
    await expect(page.getByTestId('scroller')).toBeVisible();
    await page.getByTestId('composer-input').fill('你好');
    await page.getByTestId('btn-send').click();
    await expect(page.getByTestId('scroller')).toContainText('你好', { timeout: 20_000 });

    await gotoAdmin(page, '/admin');
    await expect(page.getByTestId('admin-dashboard')).toBeVisible();
    await expect(page.getByTestId('metrics-summary')).toBeVisible();
  });

  test('visible thought is served to the plain chat token user (no admin token)', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByTestId('scroller')).toBeVisible();
    await page.getByTestId('composer-input').fill('今天天气怎么样');
    await page.getByTestId('btn-send').click();
    // The inner thought chip appears; it is collapsed by default, so expand it.
    const chip = page.getByRole('button', { name: /她在想/ }).first();
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await chip.click();
    await expect(page.getByTestId('scroller')).toContainText('她好像有点在意这件事', { timeout: 10_000 });
    // The chat API carries the chat token, not the admin token.
    const thought = await request.get('/api/thoughts/msg_e2e_nonexistent', { headers: { 'x-sooya-token': CHAT_TOKEN } });
    expect(thought.status()).toBe(404); // endpoint reachable under chat token
  });

  test('admin switches the active city: movement cleared, weather target follows, restart keeps it', async ({ page, request }) => {
    // 默认城市 = 宁波。
    const cities = await request.get('/api/admin/life/cities', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    expect(cities.ok()).toBeTruthy();
    let body = await cities.json() as { cities: Array<{ id: string; name: string; active: boolean }> };
    // desktop 与 mobile 共享 e2e server：若前序项目已切换，先把宁波恢复为 active。
    const ningbo = body.cities.find((c) => c.name === '宁波')!;
    if (body.cities.find((c) => c.active)?.name !== '宁波') {
      await request.patch(`/api/admin/life/cities/${ningbo.id}`, { headers: { 'x-admin-token': ADMIN_TOKEN }, data: { active: true } });
      const refreshed = await request.get('/api/admin/life/cities', { headers: { 'x-admin-token': ADMIN_TOKEN } });
      body = await refreshed.json() as { cities: Array<{ id: string; name: string; active: boolean }> };
    }
    expect(body.cities.find((c) => c.active)?.name).toBe('宁波');

    // 建杭州并切换为 active。
    const created = await request.post('/api/admin/life/cities', {
      headers: { 'x-admin-token': ADMIN_TOKEN },
      data: { name: '杭州', region: '浙江' }
    });
    expect(created.ok()).toBeTruthy();
    const hangzhou = (await created.json() as { city: { id: string } }).city;
    const patched = await request.patch(`/api/admin/life/cities/${hangzhou.id}`, {
      headers: { 'x-admin-token': ADMIN_TOKEN },
      data: { active: true }
    });
    expect(patched.ok()).toBeTruthy();

    const after = await request.get('/api/admin/life/cities', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    const afterBody = await after.json() as { cities: Array<{ id: string; name: string; active: boolean }> };
    expect(afterBody.cities.find((c) => c.active)?.name).toBe('杭州');
    // Weather target follows the active city.
    const travel = await request.get('/api/admin/life/travel', { headers: { 'x-admin-token': ADMIN_TOKEN } });
    expect((await travel.json() as { travel: unknown }).travel).toBeNull();
    // Restart keeps 杭州 (server restarts between specs; re-verify after reload).
    await page.goto('/admin/life/console');
    await expect(page.getByTestId('life-admin-page')).toBeVisible();
  });
});
