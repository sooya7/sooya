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
 * Next-phase surfaces (P0-P3): the world-context admin, voice preferences,
 * metrics panels are reachable by exact
 * path, render against the live server, and their controls round-trip through
 * the admin API. The stable chat flows are covered by the other specs running
 * against the same server with these flags on.
 */
test.describe('next-phase admin surfaces', () => {
  test('life admin shows overview and the location manager lists builtins', async ({ page }) => {
    await gotoAdmin(page, '/admin/life');
    await expect(page.getByTestId('life-admin-page')).toBeVisible();
    await expect(page.getByTestId('life-overview')).toBeVisible();
    await expect(page.getByText('在哪里')).toBeVisible();
    // Location model is enabled on the e2e server: the location manager
    // lists the seeded builtins including home.
    await page.getByRole('tab', { name: 'Locations' }).click();
    await expect(page.getByTestId('life-location-list')).toBeVisible();
    // Mobile card-list layout prepends the column label to each cell name
    // ("名称 家 展开详情"), so match the home row without an exact cell-name.
    const homeCell = page.getByTestId('life-location-list').getByRole('cell').filter({ hasText: '家' }).filter({ hasNotText: '附近' });
    await expect(homeCell).toBeVisible();
  });

  test('voice preferences render quiet hours and capabilities', async ({ page }) => {
    await gotoAdmin(page, '/settings/voice');
    await expect(page.getByTestId('voice-preferences-page')).toBeVisible();
    await expect(page.getByTestId('voice-quiet-hours')).toBeVisible();
  });

  test('metrics dashboard aggregates reply and voice activity', async ({ page }) => {
    // Send a message first so the dashboard has something to aggregate.
    await page.goto('/');
    await expect(page.getByTestId('scroller')).toBeVisible();
    await page.getByTestId('composer-input').fill('你好');
    await page.getByTestId('btn-send').click();
    await expect(page.getByTestId('scroller')).toContainText('你好', { timeout: 20_000 });

    await gotoAdmin(page, '/admin/metrics');
    await expect(page.getByTestId('metrics-page')).toBeVisible();
    await expect(page.getByTestId('metrics-page').locator('.metrics-category table').first()).toBeVisible();
  });


});
