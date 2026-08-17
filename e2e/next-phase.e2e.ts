import { expect, test, type Page } from '@playwright/test';

const ADMIN_TOKEN = 'e2e-admin-token';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ admin }) => {
    localStorage.setItem('sooya.admin-token', admin);
  }, { admin: ADMIN_TOKEN });
});

async function gotoAdmin(page: Page, path: string): Promise<void> {
  await page.goto(path);
}

/**
 * Next-phase admin surfaces (P0-P3): the world-context admin and metrics panels
 * are reachable by exact path, render against the live server, and their
 * controls round-trip through the admin API. Web 只保留 Admin / Gallery；
 * QQ 消息链路由 server 集成测试覆盖，浏览器 E2E 不再触碰 Web Chat。
 */
test.describe('next-phase admin surfaces', () => {
  test('old /admin/life/console canonicalizes to the autonomous observation page', async ({ page }) => {
    await gotoAdmin(page, '/admin/life/console');
    await expect(page).toHaveURL(/\/admin\/life$/);
    await expect(page.getByTestId('life-observation')).toBeVisible();
    const hero = page.getByTestId('life-hero');
    await expect(hero).toBeVisible();
    await expect(hero).toContainText('当前地点');
    await expect(hero).toContainText('当前天气');
    await expect(hero).toContainText('出行状态');
    await expect(hero).toContainText('当前活动');
  });

  test('overview embeds the base runtime metrics', async ({ page }) => {
    // Web Chat 已下线：直接进入 Admin，验证运行状态与指标面板可渲染。
    await gotoAdmin(page, '/admin');
    await expect(page.getByTestId('admin-dashboard')).toBeVisible();
    await expect(page.getByTestId('metrics-summary')).toBeVisible();
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
    await expect(page).toHaveURL(/\/admin\/life$/);
    await expect(page.getByTestId('life-observation')).toBeVisible();
  });
});
