# Mobile Admin Panel Phase One Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mobile-first, read-only SOOYA administration dashboard at `/admin`, with a gear entry from chat, an admin-token lock screen, and a return-to-chat action.

**Architecture:** The React application becomes route-aware using `window.location.pathname`, while retaining the existing single-page chat experience at `/`. A small admin API client reads and stores `ADMIN_API_TOKEN` separately from `WEB_CHAT_TOKEN`, then fetches the existing read-only admin endpoints for the dashboard. The server adds only SPA history fallback for `/admin`; no data model or management API changes are required.

**Tech Stack:** React 19, TypeScript, Vite, Fastify 5, Playwright E2E, existing SOOYA admin REST endpoints.

---

## File Structure

- Modify: `packages/web/src/App.tsx` — render chat or the admin route and provide the header gear link.
- Create: `packages/web/src/components/AdminPanel.tsx` — mobile-first status dashboard and locked state.
- Create: `packages/web/src/lib/admin.ts` — separate admin-token storage and authenticated read-only admin requests.
- Modify: `packages/web/src/styles.css` — gear control and responsive admin dashboard styles.
- Modify: `packages/server/src/app.ts` — serve the SPA index for `/admin` without intercepting `/api/*` routes.
- Modify: `e2e/chat.e2e.ts` — browser-level coverage for navigation, locked state, and status display.

### Task 1: Prove the desired route and entry behavior in E2E

**Files:**

- Modify: `e2e/chat.e2e.ts`

- [ ] **Step 1: Write failing navigation and lock-state tests**

Append these tests after the existing chat navigation tests:

```ts
test('opens the admin panel from the chat header in the current tab', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('admin-entry').click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId('admin-lock')).toBeVisible();
});

test('shows dashboard status after a valid admin token is stored', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sooya.admin-token', 'e2e-admin-token'));
  await page.goto('/admin');
  await expect(page.getByTestId('admin-dashboard')).toBeVisible();
  await expect(page.getByTestId('admin-system-status')).toContainText('运行正常');
  await expect(page.getByTestId('admin-return-chat')).toBeVisible();
});
```

- [ ] **Step 2: Run the focused E2E tests and verify they fail because the entry and dashboard do not exist**

Run: `npm run test:e2e -- --grep "opens the admin panel|shows dashboard status"`

Expected: FAIL with missing `admin-entry` and `/admin` rendering the chat page.

- [ ] **Step 3: Commit the red test**

```bash
git add e2e/chat.e2e.ts
git commit -m "test: define mobile admin entry behavior"
```

If the delivered source archive has no `.git` directory, record the staged test change and continue without a commit.

### Task 2: Add isolated admin authentication and read-only API access

**Files:**

- Create: `packages/web/src/lib/admin.ts`
- Modify: `e2e/chat.e2e.ts`

- [ ] **Step 1: Extend the failing E2E test with rejected-token behavior**

Add a test that uses an invalid stored token and asserts the lock screen returns after the admin request returns 401:

```ts
test('returns to the locked admin state when the stored admin token is rejected', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('sooya.admin-token', 'invalid-token'));
  await page.goto('/admin');
  await expect(page.getByTestId('admin-lock')).toBeVisible();
  expect(await page.url()).not.toContain('invalid-token');
});
```

- [ ] **Step 2: Run the focused test and verify it fails for missing admin authentication handling**

Run: `npm run test:e2e -- --grep "rejected admin token"`

Expected: FAIL because no admin API request or `admin-lock` state exists.

- [ ] **Step 3: Create the minimal admin client**

Create `packages/web/src/lib/admin.ts` with separate storage and a typed request helper:

```ts
import { ApiError } from './api.js';

const ADMIN_TOKEN_KEY = 'sooya.admin-token';

export function getAdminToken(): string | null {
  try { return localStorage.getItem(ADMIN_TOKEN_KEY); } catch { return null; }
}

export function setAdminToken(token: string): void {
  try { localStorage.setItem(ADMIN_TOKEN_KEY, token); } catch { /* private mode */ }
}

export function clearAdminToken(): void {
  try { localStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* private mode */ }
}

async function adminRequest<T>(path: string): Promise<T> {
  const token = getAdminToken();
  const res = await fetch(path, { headers: token ? { 'x-admin-token': token } : {} });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body as { message?: string })?.message ?? `request failed (${res.status})`, res.status, body);
  return body as T;
}

export const adminApi = {
  system: () => adminRequest<{ version: string; uptimeSec: number; memoryMb: number; database: { messages: number; memories: number; pendingJobs: number }; storage: { mediaBytes: number } }>('/api/admin/system'),
  capabilities: () => adminRequest<{ capabilities: Record<string, { configured: boolean; ok: boolean }> }>('/api/admin/capabilities'),
  backups: () => adminRequest<{ backups: Array<{ name: string; createdAt?: string }> }>('/api/admin/backups')
};
```

- [ ] **Step 4: Run the rejected-token E2E test and verify it still fails only because the UI has not consumed the client yet**

Run: `npm run test:e2e -- --grep "rejected admin token"`

Expected: FAIL with the missing dashboard/lock UI assertion, not a TypeScript compilation failure.

- [ ] **Step 5: Commit the API client**

```bash
git add packages/web/src/lib/admin.ts e2e/chat.e2e.ts
git commit -m "feat: add isolated admin API client"
```

### Task 3: Render the mobile-first dashboard and locked state

**Files:**

- Create: `packages/web/src/components/AdminPanel.tsx`
- Modify: `packages/web/src/styles.css`

- [ ] **Step 1: Create the component with its locked, loading, error, and loaded states**

Implement `AdminPanel` so it:

```tsx
export function AdminPanel(): JSX.Element {
  // Load system, capabilities, and backups in Promise.all after an admin token is present.
  // On ApiError 401 or 503, clear the stored admin token and render data-testid="admin-lock".
  // The lock form stores the supplied token then retries loading.
  // The loaded view renders data-testid="admin-dashboard", "admin-system-status",
  // and "admin-return-chat", plus four non-destructive cards: 状态, 对话与记忆,
  // 人设与能力, 维护. Cards show "即将推出" for phase-two actions.
}
```

The top row must use an anchor with `href="/"` for `admin-return-chat`; do not include a token in its URL. The status card must show version, uptime, database message count, memory count, pending jobs, available/failed capabilities, storage usage, and latest backup metadata from the returned endpoints.

- [ ] **Step 2: Add responsive CSS matching the approved mockup**

Add `.admin-page`, `.admin-topbar`, `.admin-back`, `.admin-summary`, `.admin-card-grid`, `.admin-card`, `.admin-lock`, and `.admin-error` styles. Requirements: minimum 44px target for the back control and cards; one column at narrow widths; two summary tiles; no horizontal overflow; existing color tokens and fonts retained.

- [ ] **Step 3: Run the three admin E2E tests and verify they pass**

Run: `npm run test:e2e -- --grep "admin panel|admin token"`

Expected: PASS for navigation, valid-token dashboard, and rejected-token lock state.

- [ ] **Step 4: Commit the dashboard component and styles**

```bash
git add packages/web/src/components/AdminPanel.tsx packages/web/src/styles.css e2e/chat.e2e.ts
git commit -m "feat: add mobile admin dashboard"
```

### Task 4: Wire real `/admin` routing and the chat-header gear entry

**Files:**

- Modify: `packages/web/src/App.tsx`
- Modify: `packages/server/src/app.ts`
- Modify: `e2e/chat.e2e.ts`

- [ ] **Step 1: Keep the Task 1 navigation test red until routing is added**

Run: `npm run test:e2e -- --grep "opens the admin panel"`

Expected: FAIL until both the gear link and SPA fallback are present.

- [ ] **Step 2: Add the minimal route-aware application shell**

In `App.tsx`, import `AdminPanel`; before invoking `useChat`, branch on `window.location.pathname` so `/admin` renders `<AdminPanel />`, while `/` renders the existing chat component moved into a `ChatApp` child. Add this exact header link next to `.topbar-identity`:

```tsx
<a className="topbar-admin-entry" href="/admin" aria-label="进入管理面板" data-testid="admin-entry">
  <span aria-hidden="true">⚙</span>
</a>
```

Use a normal anchor, not `window.location` mutation, so the current-tab navigation works without a router dependency.

- [ ] **Step 3: Add server history fallback only for `/admin`**

In `packages/server/src/app.ts`, after static web assets are registered and after all `/api/*` routes are registered, add a GET handler for `/admin` that returns the same web `index.html` used by the root SPA. Preserve API route precedence and return 404 if `WEB_DIR` is unavailable.

- [ ] **Step 4: Run the navigation test and verify it passes**

Run: `npm run test:e2e -- --grep "opens the admin panel"`

Expected: PASS; URL ends in `/admin` and the lock screen is visible when no admin token exists.

- [ ] **Step 5: Commit route integration**

```bash
git add packages/web/src/App.tsx packages/server/src/app.ts packages/web/src/styles.css e2e/chat.e2e.ts
git commit -m "feat: route chat header to admin dashboard"
```

### Task 5: Run full verification and deploy the release

**Files:**

- Modify: generated build output only during deployment; do not commit `packages/web/dist`.

- [ ] **Step 1: Run all checks**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: each command exits 0. If Windows path handling causes existing sticker tests to fail, run the full test suite in the Linux deployment environment and record that the failure is environmental before deploying.

- [ ] **Step 2: Build a new immutable server release**

Upload the changed source without `node_modules`, run the existing `/opt/sooya` installer to create a new timestamped release, retain `/opt/sooya/shared/.env`, `config/`, and `data/`, then restart `sooya`.

- [ ] **Step 3: Verify deployment without exposing either token**

Run on the server:

```bash
curl -fsS http://127.0.0.1:8788/health/ready
curl -fsS --resolve echo.sooya.icu:443:104.21.21.39 https://echo.sooya.icu/health/ready
```

Then run the targeted Playwright admin tests against the deployed release using a locally stored admin token, and confirm `/`, `/admin`, the locked state, and valid-token dashboard all render.

- [ ] **Step 4: Record rollback data**

Keep the preceding `/opt/sooya/releases/<timestamp>` target and `/opt/sooya/shared` state unchanged. To roll back, repoint `/opt/sooya/current` to the previous release and restart `sooya`; do not restore or overwrite shared data.

## Plan Self-Review

- Spec coverage: Tasks 1–4 cover the gear entry, current-tab `/admin` route, mobile read-only status panel, independent admin-token lock state, return-to-chat action, and phase-one cards. Task 5 covers deploy and rollback. Phase-two destructive controls are explicitly excluded.
- Completeness scan: all implementation, test, deployment, and rollback actions are specified.
- Type consistency: all UI code uses `adminApi`, `getAdminToken`, `setAdminToken`, `clearAdminToken`, `AdminPanel`, and the fixed storage key `sooya.admin-token`.
