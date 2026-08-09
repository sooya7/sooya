# Model Configuration Single Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `models.json` the live single source for every model capability and add web search as an editor inside the existing model configuration page.

**Architecture:** Version and migrate `models.json` once from legacy environment-backed settings, then stop applying model/search environment overrides. A watched `ConfigStore` publishes valid model changes to the capability registry and a reloadable web-search registry. Existing admin model APIs remain the single browser entry point and recursively redact secrets.

**Tech Stack:** TypeScript, Node.js `fs.watch`, Zod, Fastify, React, Vitest, jsdom.

---

## File map

- Modify `packages/server/src/config/schema.ts`: versioned model/search schemas.
- Modify `packages/server/src/config/store.ts`: one-time legacy migration, recursive redaction, safe disk reload and watcher lifecycle.
- Modify `packages/server/src/config/env.ts`: retain legacy variables only as migration inputs.
- Create `packages/server/src/core/web-search/registry.ts`: rebuildable search service backed by current config.
- Modify `packages/server/src/app.ts`: construct and close the registry/watcher.
- Modify `packages/server/src/routes/admin.ts`: rebuild search on model saves and add real provider test endpoint.
- Modify `packages/web/src/lib/admin.ts`: typed search configuration and test API.
- Modify `packages/web/src/components/AdminPanel.tsx`: add “联网搜索” inside the existing model capability editor.
- Modify `packages/web/src/components/AdminPanel.css`: compact provider ordering and key controls.
- Update server and web tests plus deployment/API documentation.

### Task 1: Versioned schema and one-time migration

**Files:**
- Modify: `packages/server/src/config/schema.ts`
- Modify: `packages/server/src/config/store.ts`
- Test: `packages/server/test/config-single-source.test.ts`

- [ ] **Step 1: Write failing schema and migration tests**

```ts
it('migrates legacy model and search env into storageVersion 2 once', () => {
  const store = new ConfigStore({ configDir, env: legacyEnv });
  expect(store.getModels().storageVersion).toBe(2);
  expect(store.getModels().chat.apiKey).toBe('legacy-chat');
  expect(store.getModels().webSearch.providers).toEqual(['doubao', 'tavily', 'responses']);
  expect(JSON.parse(readFileSync(store.modelsPath, 'utf8')).webSearch.doubao.apiKey).toBe('legacy-doubao');
});

it('ignores model environment variables after migration', () => {
  writeModels({ storageVersion: 2, chat: { provider: 'openai-compatible', apiKey: 'file-key' } });
  const store = new ConfigStore({ configDir, env: { SOOYA_CHAT_API_KEY: 'env-key' } });
  expect(store.getModels().chat.apiKey).toBe('file-key');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -w @sooya/server -- config-single-source.test.ts`

Expected: FAIL because `storageVersion` and `webSearch` do not exist and environment overrides still run.

- [ ] **Step 3: Add the schemas**

```ts
const SearchProviderSchema = z.enum(['doubao', 'tavily', 'responses']);
const WebSearchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providers: z.array(SearchProviderSchema).max(3).transform(uniqueProviders),
  maxResults: z.number().int().min(1).max(20).default(5),
  timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
  doubao: z.object({ edition: z.enum(['custom', 'global']).default('custom'), baseUrl: z.string().url(), apiKey: z.string().default('') }).default({}),
  tavily: z.object({ baseUrl: z.string().url(), apiKey: z.string().default('') }).default({})
});
```

Set `storageVersion: z.literal(2).default(2)` and `webSearch` on `ModelsConfigSchema`. Remove `configSource` and `apiKeyEnv` from persisted v2 sections.

- [ ] **Step 4: Implement one-time migration**

Split legacy resolution into `migrateLegacyModels(raw, env)`. Only call it when raw data does not contain `storageVersion: 2`; persist the fully resolved result atomically with mode `0600`. Version-2 loads parse the file directly without environment overlays.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -w @sooya/server -- config-single-source.test.ts config-env.test.ts foundation-regressions.test.ts`

Commit: `feat: make models json the model configuration source`

### Task 2: Safe reload, recursive redaction, and file watching

**Files:**
- Modify: `packages/server/src/config/store.ts`
- Test: `packages/server/test/config-single-source.test.ts`

- [ ] **Step 1: Write failing behavior tests**

```ts
it('keeps the last valid configuration when an external edit is invalid', async () => {
  const store = new ConfigStore({ configDir });
  const before = store.getModels().chat.model;
  writeFileSync(store.modelsPath, '{broken');
  await watcherTick();
  expect(store.getModels().chat.model).toBe(before);
});

it('redacts nested web search keys', () => {
  expect(store.safeModels().webSearch).toMatchObject({
    doubao: { apiKeyConfigured: true },
    tavily: { apiKeyConfigured: true }
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @sooya/server -- config-single-source.test.ts`

- [ ] **Step 3: Implement safe reload and watcher API**

Add `reloadModelsFromDisk(): boolean`, `watchModels(onChange): () => void`, a 150 ms debounce, and recursive `redactApiKeys`. Invalid JSON/schema results log and return `false` without changing `this.models`.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -w @sooya/server -- config-single-source.test.ts security.test.ts panel-api-key.test.ts`

Commit: `feat: hot reload validated model configuration`

### Task 3: Reloadable web-search registry

**Files:**
- Create: `packages/server/src/core/web-search/registry.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/core/replier.ts`
- Test: `packages/server/test/web-search-registry.test.ts`
- Test: `packages/server/test/web-search-integration.test.ts`

- [ ] **Step 1: Write failing registry tests**

```ts
it('rebuilds provider order from models.json without restarting', async () => {
  registry.rebuild(configWithProviders(['tavily', 'doubao']));
  await registry.resolve(request);
  expect(calls).toEqual(['tavily']);
});

it('returns disabled when the page turns search off', async () => {
  registry.rebuild(configWithEnabled(false));
  expect(registry.enabled).toBe(false);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @sooya/server -- web-search-registry.test.ts`

- [ ] **Step 3: Implement registry**

`WebSearchRegistry` owns the current `WebSearchService | null`, builds Doubao/Tavily adapters from `ModelsConfig['webSearch']`, and forwards `resolve()` to the current instance. It exposes `rebuild()` and never logs secrets.

- [ ] **Step 4: Wire app lifecycle**

Construct the registry from `config.getModels().webSearch`, pass it to `Replier`, rebuild capabilities and search on a successful watched file change, and close the watcher through Fastify `onClose`.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -w @sooya/server -- web-search-registry.test.ts web-search-integration.test.ts`

Commit: `feat: hot rebuild web search providers`

### Task 4: Admin API and real provider tests

**Files:**
- Modify: `packages/server/src/routes/admin.ts`
- Test: `packages/server/test/admin-web-search.test.ts`
- Test: `packages/server/test/security.test.ts`

- [ ] **Step 1: Write failing API tests**

```ts
it('saves web search under the existing models endpoint and rebuilds it', async () => {
  const res = await putModels({ webSearch: { enabled: true, providers: ['tavily'] } });
  expect(res.json().models.webSearch.providers).toEqual(['tavily']);
  expect(h.app.services.webSearch.enabled).toBe(true);
});

it('tests a saved provider without returning its key', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/admin/models/web-search/test', headers: ADMIN, payload: { provider: 'doubao', query: 'OpenAI' } });
  expect(res.json()).toMatchObject({ ok: true, provider: 'doubao', resultCount: 1 });
  expect(res.body).not.toContain('secret-key');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @sooya/server -- admin-web-search.test.ts security.test.ts`

- [ ] **Step 3: Implement save/rebuild and test endpoint**

After `config.setModels`, rebuild both `services.capabilities` and `services.webSearch`. Validate the test payload with Zod, perform one real saved-provider request, return `{ ok, provider, latencyMs, resultCount }`, and sanitize all failures.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -w @sooya/server -- admin-web-search.test.ts security.test.ts model-connection-test.test.ts`

Commit: `feat: manage web search through model admin api`

### Task 5: Existing model-page search editor

**Files:**
- Modify: `packages/web/src/lib/admin.ts`
- Modify: `packages/web/src/components/AdminPanel.tsx`
- Modify: `packages/web/src/components/AdminPanel.css`
- Test: `packages/web/src/components/AdminPanel.test.tsx`
- Test: `packages/web/src/lib/admin.test.ts`

- [ ] **Step 1: Write failing UI tests**

```tsx
it('edits web search inside the existing model configuration page', async () => {
  renderAdmin('/admin/models');
  await user.click(await screen.findByRole('button', { name: /联网搜索/ }));
  expect(screen.getByLabelText('启用联网搜索')).toBeChecked();
  expect(screen.getByLabelText('豆包版本')).toHaveValue('custom');
  expect(screen.getByText('Responses')).toBeInTheDocument();
});

it('reorders providers and saves without echoing keys', async () => {
  await moveProvider('tavily', 'up');
  await user.click(screen.getByRole('button', { name: '保存搜索配置' }));
  expect(lastModelsPatch.webSearch.providers).toEqual(['tavily', 'doubao', 'responses']);
  expect(screen.queryByDisplayValue('server-secret')).toBeNull();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -w @sooya/web -- AdminPanel.test.tsx admin.test.ts`

- [ ] **Step 3: Implement types and API client**

Add `AdminWebSearchConfig`, nested redacted key types, and `testWebSearch(provider, query)` to `admin.ts`.

- [ ] **Step 4: Implement the inline editor**

Add a `webSearch` item to the existing model capability sidebar. Render a specialized form within `ModelsPanel`, with enabled toggle, provider checkboxes/order buttons, common limits, Doubao edition, redacted key inputs, advanced base URLs, save, explicit clear-key actions, and per-provider test results.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -w @sooya/web -- AdminPanel.test.tsx admin.test.ts`

Commit: `feat: configure web search in model settings`

### Task 6: Documentation, full verification, migration, and deployment

**Files:**
- Modify: `.env.example`
- Modify: `docs/API.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `README.md`

- [ ] **Step 1: Update operator documentation**

Document `models.json` as the model/search source, the one-time migration, direct file edits with automatic reload, recursive key redaction, and the fact that search is inside `/admin/models`. Mark legacy model/search environment variables as migration-only and remove them from the normal `.env.example` workflow.

- [ ] **Step 2: Run focused and full verification**

```bash
npm test -w @sooya/server -- config-single-source.test.ts web-search-registry.test.ts admin-web-search.test.ts web-search-integration.test.ts
npm test -w @sooya/web -- AdminPanel.test.tsx admin.test.ts
npm test -w @sooya/server
npm test -w @sooya/web
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 3: Commit documentation**

Commit: `docs: document unified model configuration`

- [ ] **Step 4: Merge, push, and wait for CI**

Fast-forward `main`, push `origin/main`, and require the full GitHub workflow to succeed before deployment.

- [ ] **Step 5: Deploy and migrate production**

Create verified data and configuration backups, deploy through the existing upgrade script, confirm `models.json` contains `storageVersion: 2` with redacted inspection, remove migrated model/search variables from production `.env`, restart once only if deployment requires it, and verify local/public readiness.

- [ ] **Step 6: End-to-end production verification**

Use the management API to read the redacted search config, modify and restore a harmless setting to prove page/file consistency, run a saved-provider test, send a real search-intent chat message, and confirm provider metadata plus clickable citations.

- [ ] **Step 7: Clean branch and shut down**

Remove the merged worktree and feature branch, verify the main worktree retains only the user's pre-existing untracked files, then schedule the user-authorized Windows shutdown after the final report has been delivered.
