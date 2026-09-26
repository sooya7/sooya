import { DatabaseSync } from 'node:sqlite';
import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  ADMIN_HEADERS, ADMIN_TOKEN, databaseFile, fillField, installAdminToken, openConsolePage, pageTitle, restartServer, section
} from './helpers.js';
import { MOCK_PORT } from './server.js';

/**
 * Console shell and the next-phase surfaces: old addresses land on their new
 * page, the landing page and 运行状况 show live runtime metrics, and switching
 * her city (生活 › 地点与天气 › 城市) clears travel, moves the weather target
 * and survives a real server restart.
 */

const toast = (page: Page, text: string | RegExp) => page.locator('.cs-toasts').getByText(text);

async function adminGet<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path, { headers: ADMIN_HEADERS });
  expect(response.ok(), `${path} → ${response.status()}`).toBeTruthy();
  return await response.json() as T;
}

test.describe('旧地址与登录', () => {
  test.beforeEach(async ({ page }) => { await installAdminToken(page); });

  const LEGACY: Array<[from: string, to: string, title: string]> = [
    ['/gallery', '/admin/media', '相册与表情'],
    ['/admin/avatar', '/admin/look', '形象'],
    ['/admin/voice', '/admin/persona', '人设与声音'],
    ['/admin/features', '/admin/persona', '人设与声音'],
    ['/admin/content', '/admin/media', '相册与表情'],
    ['/admin/mcp', '/admin/tools', '工具'],
    ['/admin/operations', '/admin/ops', '运行状况'],
    ['/admin/overview', '/admin', '此刻'],
    ['/admin/life/console', '/admin/life', '生活'],
    ['/admin/storage/anything/deeper', '/admin/storage', '存储与备份'],
    ['/console', '/admin', '此刻'],
    ['/console/memory', '/admin/memory', '记忆'],
    ['/console/avatar', '/admin/look', '形象'],
    ['/admin/no-such-page', '/admin', '此刻'],
    ['/moments', '/admin', '此刻'],
    ['/', '/admin', '此刻']
  ];

  for (const [from, to, title] of LEGACY) {
    test(`${from} 跳到 ${to}`, async ({ page, baseURL }) => {
      await page.goto(from);
      await expect(page).toHaveURL(`${baseURL}${to}`);
      await expect(pageTitle(page, title)).toBeAttached();
      await expect(page).toHaveTitle(title === '此刻' ? 'SOOYA' : `${title} · SOOYA`);
    });
  }

  test('跳转用 replace：后退不会回到旧地址再被弹回来', async ({ page, baseURL }) => {
    await openConsolePage(page, '/admin/ops', '运行状况');
    const before = await page.evaluate(() => history.length);
    await page.goto('/admin/avatar');
    await expect(page).toHaveURL(`${baseURL}/admin/look`);
    // The legacy entry was replaced, not stacked on top of it.
    expect(await page.evaluate(() => history.length)).toBe(before + 1);
    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/admin/ops`);
    await expect(pageTitle(page, '运行状况')).toBeAttached();
    await page.goForward();
    await expect(page).toHaveURL(`${baseURL}/admin/look`);
  });

  test('当前页在导航里标出，站内切页不整页刷新', async ({ page }) => {
    await openConsolePage(page, '/admin/memory', '记忆');
    const nav = page.getByRole('navigation', { name: '管理栏目' });
    await expect(nav.getByRole('link', { name: '记忆', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.evaluate(() => { (window as typeof window & { __sameDocument?: boolean }).__sameDocument = true; });
    await nav.getByRole('link', { name: 'QQ 通道', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/qq$/);
    await expect(pageTitle(page, 'QQ 通道')).toBeVisible();
    await expect(nav.getByRole('link', { name: 'QQ 通道', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: '记忆', exact: true })).not.toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => (window as typeof window & { __sameDocument?: boolean }).__sameDocument)).toBe(true);
  });
});

test.describe('登录', () => {
  test('没有令牌时显示登录页；错的令牌被退回；对的令牌进入原来要去的页面；退出后清掉令牌', async ({ page, baseURL }) => {
    await page.goto('/admin/avatar');
    const tokenField = page.getByLabel('管理令牌');
    await expect(page.getByRole('heading', { name: 'SOOYA', level: 1 })).toBeVisible();
    await expect(tokenField).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: '进入' })).toBeDisabled();

    // A wrong token is only rejected by the server: the first 401 sends us back.
    await tokenField.fill('wrong-token');
    await page.getByRole('button', { name: '进入' }).click();
    await expect(page.getByLabel('管理令牌')).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sooya.admin-token'))).toBeNull();

    await page.getByLabel('管理令牌').fill(ADMIN_TOKEN);
    await page.getByLabel('管理令牌').press('Enter');
    await expect(page).toHaveURL(`${baseURL}/admin/look`);
    await expect(pageTitle(page, '形象')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sooya.admin-token'))).toBe(ADMIN_TOKEN);

    // The token survives a reload.
    await page.reload();
    await expect(pageTitle(page, '形象')).toBeVisible();

    await page.getByRole('navigation', { name: '管理栏目' }).getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByLabel('管理令牌')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sooya.admin-token'))).toBeNull();
  });
});

test.describe('运行指标', () => {
  test.beforeEach(async ({ page }) => { await installAdminToken(page); });

  test('首页「系统」一节展示服务、能力、错误、备份和数据量，并能跳到对应页面', async ({ page, request }) => {
    const system = await adminGet<{ version: string; database: Record<string, number> }>(request, '/api/admin/system');
    const errors = await adminGet<{ errors: unknown[] }>(request, '/api/admin/errors');
    const caps = await adminGet<{ capabilities: Record<string, { ok?: boolean; configured?: boolean }> }>(request, '/api/admin/capabilities');
    const entries = Object.entries(caps.capabilities);
    const ready = entries.filter(([, value]) => value && (value.ok || value.configured)).length;

    await page.goto('/admin');
    await expect(page.getByRole('banner', { name: '她此刻的状态' })).toBeVisible();
    await expect(page.getByRole('banner', { name: '她此刻的状态' }).locator('time')).toHaveText(/^\d{2}:\d{2}$/);

    const box = section(page, '系统');
    await expect(box.getByText(/^服务在运行，已连续运行 \d+/)).toBeVisible();
    const capability = box.locator('.cs-stat').filter({ hasText: '项能力可用' });
    await expect(capability.locator('.cs-stat-value')).toHaveText(`${ready}/ ${entries.length}`);
    const errorStat = box.locator('.cs-stat').filter({ hasText: '错误记录' });
    await expect(errorStat.locator('.cs-stat-value')).toHaveText(`${errors.errors.length}条`);
    await expect(box.locator('.cs-stat').filter({ hasText: /最近一次备份|还没有任何备份/ })).toBeVisible();
    for (const label of ['消息', '记忆', '媒体文件', '待处理任务', '版本', '启动于']) {
      await expect(box.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) })).toBeVisible();
    }
    await expect(box.getByRole('definition').filter({ hasText: system.version }).first()).toBeVisible();
    await expect(box.getByText(`${Number(system.database.media ?? 0).toLocaleString()} 个，`)).toBeVisible();

    await box.getByRole('button', { name: '查看运行状况' }).click();
    await expect(page).toHaveURL(/\/admin\/ops$/);
    await expect(pageTitle(page, '运行状况')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/admin$/);
    await section(page, '系统').getByRole('button', { name: '去备份' }).click();
    await expect(page).toHaveURL(/\/admin\/storage$/);
  });

  test('运行状况页：系统与能力、任务与错误、操作记录三个分类读实时数据', async ({ page, request }) => {
    const system = await adminGet<{ version: string }>(request, '/api/admin/system');
    await page.goto('/admin/ops');
    const tabs = page.getByRole('tablist', { name: '运行状况分类' });
    await expect(tabs.getByRole('tab', { name: '系统与能力' })).toHaveAttribute('aria-selected', 'true');

    const sys = section(page, '系统');
    await expect(sys.getByText('服务在运行')).toBeVisible();
    await expect(sys.getByRole('definition').filter({ hasText: system.version }).first()).toBeVisible();
    for (const label of ['已连续运行', '占用内存', '运行环境']) await expect(sys.getByText(label, { exact: true })).toBeVisible();
    for (const label of ['消息', '媒体占用', '数据库大小', '磁盘剩余', '空间提醒']) {
      await expect(section(page, '数据与存储').getByText(label, { exact: true })).toBeVisible();
    }
    await expect(section(page, '实时推送与代理').getByText('正在接收实时推送的页面')).toBeVisible();
    await expect(section(page, '能力').getByText(/^\d+ \/ \d+ 项可用$/)).toBeVisible();
    // The server runs with the world flags on; the policy says so in words.
    const policy = section(page, '能力策略');
    for (const label of ['世界信息', '地点', '天气']) {
      await expect(policy.locator('.cs-fact').filter({ has: page.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) }) })).toContainText('开启');
    }

    await tabs.getByRole('tab', { name: '任务与错误' }).click();
    await expect(page).toHaveURL(/\/admin\/ops#health$/);
    await expect(section(page, '错误记录')).toBeVisible();
    await expect(section(page, '后台任务')).toBeVisible();
    await expect(section(page, '后台任务').getByRole('button', { name: '刷新任务' })).toBeVisible();

    // 统计 against live data is covered by its own test below.

    await tabs.getByRole('tab', { name: '操作记录' }).click();
    await expect(page).toHaveURL(/\/admin\/ops#audit$/);
    await expect(section(page, '操作记录')).toBeVisible();

    // A hash from an old link (#errors) opens the matching tab on load.
    await page.goto('/admin');
    await page.goto('/admin/ops#errors');
    await expect(page.getByRole('tab', { name: '任务与错误' })).toHaveAttribute('aria-selected', 'true');
  });

  test('统计分类在服务器真实数据下能打开（不白屏）', async ({ page, request }) => {
    // GET /api/admin/metrics returns rows without `avg` (metrics.repo.ts
    // aggregates() only selects sum and count, though MetricAggregate declares
    // avg). Ops.tsx renders num(row.avg) → undefined.toLocaleString() throws,
    // and with no error boundary the whole console goes blank. The life
    // simulation records metrics within seconds, so live data is never empty.
    const live = await adminGet<{ aggregates: Array<Record<string, unknown>> }>(request, '/api/admin/metrics?days=7');
    expect(live.aggregates.length).toBeGreaterThan(0);
    await page.goto('/admin/ops#metrics');
    await expect(pageTitle(page, '运行状况')).toBeVisible();
    await expect(section(page, '全部统计').getByRole('table')).toBeVisible();
  });

  // The routed rows carry `avg`; the live server omits it and the page derives it from sum/count.
  test('统计分类把接口数据换算成成功率、平均等待和明细表', async ({ page }) => {
    const aggregates = [
      { category: 'reply', metric: 'start', count: 10, sum: 10, avg: 1 },
      { category: 'reply', metric: 'success', count: 9, sum: 9, avg: 1 },
      { category: 'reply', metric: 'first_visible_ms', count: 9, sum: 22_500, avg: 2_500 },
      { category: 'voice', metric: 'tts_success', count: 3, sum: 3, avg: 1 },
      { category: 'voice', metric: 'tts_failure', count: 1, sum: 1, avg: 1 },
      { category: 'proactive', metric: 'sent', count: 2, sum: 2, avg: 1 }
    ];
    const distributions = [{ category: 'reply', metric: 'first_visible_ms', count: 9, min: 800, max: 6_000, mean: 2_500, p50: 2_000, p95: 5_500 }];
    const asked: string[] = [];
    await page.route('**/api/admin/metrics**', async (route) => {
      const url = new URL(route.request().url());
      asked.push(`${url.pathname}?days=${url.searchParams.get('days')}`);
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(url.pathname.endsWith('/distributions') ? { distributions } : { aggregates, daily: [] })
      });
    });

    await page.goto('/admin/ops#metrics');
    const experience = section(page, '体验');
    const fact = (label: string) => experience.locator('.cs-fact').filter({ has: page.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) }) });
    await expect(fact('到她开口的平均等待').getByRole('definition')).toHaveText('2.5 秒');
    await expect(fact('回复成功率').getByRole('definition')).toHaveText('90%');
    await expect(fact('回复次数').getByRole('definition')).toHaveText('10');
    await expect(fact('语音成功率').getByRole('definition')).toHaveText('75%');
    await expect(fact('她主动找你').getByRole('definition')).toHaveText('2 次');
    await expect(section(page, '全部统计').getByRole('table').getByRole('row')).toHaveCount(aggregates.length + 1);
    await expect(section(page, '分布').getByRole('table').getByRole('row')).toHaveCount(2);

    const range = experience.getByRole('combobox', { name: '统计时间范围' });
    const other = await range.locator('option').nth(0).getAttribute('value');
    const current = await range.inputValue();
    const next = other !== current ? other! : (await range.locator('option').nth(1).getAttribute('value'))!;
    asked.length = 0;
    await range.selectOption(next);
    await expect.poll(() => asked).toContain(`/api/admin/metrics?days=${next}`);
  });
});

test.describe('生活 › 地点与天气 › 城市', () => {
  test.beforeEach(async ({ page }) => { await installAdminToken(page); });

  test('切换当前城市：移动被清空，天气跟着换城市，重启服务后保持', async ({ page, request }) => {
    test.setTimeout(120_000);
    type City = { id: string; name: string; active: boolean };
    type Loc = { id: string; name: string; cityId?: string | null };

    // Start from 宁波, the default city (another spec may have moved her).
    let cities = (await adminGet<{ cities: City[] }>(request, '/api/admin/life/cities')).cities;
    const ningbo = cities.find((c) => c.name === '宁波')!;
    expect(ningbo).toBeTruthy();
    if (!ningbo.active) {
      const back = await request.patch(`/api/admin/life/cities/${ningbo.id}`, { headers: ADMIN_HEADERS, data: { active: true } });
      expect(back.ok()).toBeTruthy();
    }
    const hangzhouBefore = cities.find((c) => c.name === '杭州');

    // Put her on the road inside 宁波, the way the life simulation would.
    const world = await adminGet<{ locations: Loc[]; current: Loc | null }>(request, '/api/admin/life/locations');
    expect(world.current).toBeTruthy();
    const destination = world.locations.find((l) => l.id !== world.current!.id && l.cityId === ningbo.id)
      ?? world.locations.find((l) => l.id !== world.current!.id)!;
    const db = new DatabaseSync(databaseFile());
    try {
      db.exec('PRAGMA busy_timeout = 8000');
      const now = Date.now();
      db.prepare(`INSERT INTO travel_state(id, from_location_id, to_location_id, mode, started_at, expected_arrive_at, created_at)
        VALUES (1, ?, ?, 'walk', ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET from_location_id=excluded.from_location_id, to_location_id=excluded.to_location_id,
          mode=excluded.mode, started_at=excluded.started_at, expected_arrive_at=excluded.expected_arrive_at, created_at=excluded.created_at`)
        .run(world.current!.id, destination.id, new Date(now - 60_000).toISOString(), new Date(now + 3 * 3600_000).toISOString(), new Date(now).toISOString());
    } finally {
      db.close();
    }
    expect((await adminGet<{ travel: unknown }>(request, '/api/admin/life/travel')).travel).not.toBeNull();

    await page.goto('/admin/life#places');
    await expect(page.getByRole('tab', { name: '地点与天气' })).toHaveAttribute('aria-selected', 'true');
    const where = section(page, '她在哪');
    const fact = (label: string) => where.locator('.cs-fact').filter({ has: page.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) }) }).getByRole('definition');
    await expect(where.getByText(`她正从${world.current!.name}去${destination.name}。`)).toBeVisible();
    await expect(fact('出行')).toContainText('走路');
    await expect(fact('城市')).toHaveText('宁波');

    // 宁波's weather comes from the (mocked) open-meteo for 宁波: clear, 18°.
    const weather = section(page, '天气');
    await weather.getByRole('button', { name: '重新取一次天气' }).click();
    await expect(toast(page, '天气已更新')).toBeVisible();
    await expect(weather.locator('.cs-her-quote')).toContainText('18');

    const cityBox = section(page, '城市');
    const cityRow = (name: string) => cityBox.locator('.cs-list-item').filter({ has: page.getByText(name, { exact: true }) });
    await expect(cityRow('宁波').getByText('她住在这里')).toBeVisible();
    if (!hangzhouBefore) {
      await fillField(cityBox.getByLabel('城市', { exact: true }), '杭州');
      await fillField(cityBox.getByLabel('省份'), '浙江');
      await cityBox.getByRole('button', { name: '加上这座城市' }).click();
      await expect(toast(page, '杭州已加上')).toBeVisible();
    }
    await expect(cityRow('杭州')).toBeVisible();
    await expect(cityRow('杭州').getByText('浙江，中国')).toBeVisible();
    await expect(cityRow('杭州').getByText('她住在这里')).toHaveCount(0);

    // Two-step move.
    await cityRow('杭州').getByRole('button', { name: '搬到这里' }).click();
    await cityRow('杭州').getByRole('group', { name: '让她搬到杭州？进行中的出行会取消，天气会换成那边的。' })
      .getByRole('button', { name: '确定搬过去' }).click();
    await expect(toast(page, '她搬到杭州了')).toBeVisible();
    await expect(cityRow('杭州').getByText('她住在这里')).toBeVisible();
    await expect(cityRow('宁波').getByRole('button', { name: '搬到这里' })).toBeVisible();

    // Movement cleared, her place moved along with the city.
    await expect(fact('出行')).toHaveText('没在路上');
    await expect(where.getByText(/^她在.+。$/)).toBeVisible();
    await expect(fact('城市')).toHaveText('杭州');
    expect((await adminGet<{ travel: unknown }>(request, '/api/admin/life/travel')).travel).toBeNull();
    cities = (await adminGet<{ cities: City[] }>(request, '/api/admin/life/cities')).cities;
    expect(cities.filter((c) => c.active).map((c) => c.name)).toEqual(['杭州']);

    // Weather target follows the active city: the next fetch asks for 杭州 (rain, 26°).
    await weather.getByRole('button', { name: '重新取一次天气' }).click();
    await expect(weather.locator('.cs-her-quote')).toContainText('雨');
    await expect(weather.locator('.cs-her-quote')).toContainText('26');
    const mock = await (await request.get(`http://127.0.0.1:${MOCK_PORT}/__control`)).json() as { weather: { geocode: string[] } };
    expect(mock.weather.geocode).toContain('杭州');

    // Real restart on the same data: 杭州 is still home, no travel reappears.
    await restartServer();
    await page.reload();
    await expect(page.getByRole('tab', { name: '地点与天气' })).toHaveAttribute('aria-selected', 'true');
    await expect(section(page, '城市').locator('.cs-list-item').filter({ has: page.getByText('杭州', { exact: true }) }).getByText('她住在这里')).toBeVisible();
    await expect(fact('城市')).toHaveText('杭州');
    await expect(fact('出行')).toHaveText('没在路上');
    // The strip on top reads the new city too.
    await expect(page.getByLabel('她此刻的状态')).toContainText('杭州');
    await expect(async () => {
      await section(page, '天气').getByRole('button', { name: '重新取一次天气' }).click();
      await expect(section(page, '天气').locator('.cs-her-quote')).toContainText('26', { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    cities = (await adminGet<{ cities: City[] }>(request, '/api/admin/life/cities')).cities;
    expect(cities.find((c) => c.active)?.name).toBe('杭州');
  });

  test('「她现在」一节展示活动、地点、出行和天气', async ({ page }) => {
    await page.goto('/admin/life');
    await expect(page.getByRole('tab', { name: '今天' })).toHaveAttribute('aria-selected', 'true');
    const now = section(page, '她现在');
    for (const label of ['在做的是', '今天过的是', '人在', '路上', '天气', '正在做的计划']) {
      await expect(now.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) })).toBeVisible();
    }
    await expect(now.getByRole('meter', { name: '这一段' })).toBeVisible();
    await expect(now.getByRole('button', { name: '推进一次生活模拟' })).toBeVisible();
  });
});
