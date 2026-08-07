# INTEGRATION-NOTES-ui.md — Agent E (Admin/Settings UI 适配)

> Worktree: `.worktrees/sooya-ui`, branch `agent/ui-responsive` (baseline: `upgrade/world-context-admin-experiments`).
> 未修改：`AppShell.tsx` / `packages/server/*` / `App.tsx` / `chatViewState.ts` / `e2e/*` / `docs/*`。

## SUMMARY

全部 Admin/Settings UI 已按《SOOYA-下一阶段一次性完整收口与交付方案.md》§3A 完成适配，并使用冻结契约
（docs/NEXT-PHASE-CONTRACTS.md §1/§2）实现新增 UI，数据层全部走 `lib/admin.ts` 封装；后端未就绪时
每个页面都有 loading/empty/error/flag-disabled/unauthorized/provider-unconfigured 状态。

- **已有 5 页返工**：LifeAdmin（8 tabs）、VoicePreferences、MetricsDashboard、ShadowRuns、Experiments。
- **新增**：Cities/Travel/Weather Admin（LifeAdmin 内 Weather tab）、Geocode 搜索、Experiment
  Report/History、DecisionTrace 独立页、Metrics Release Compare + CSV/JSON 导出、Inner Thought UI。
- **共享基建**（`components/admin/`）：`DataList`（同一 DOM：桌面表格 / ≤680px 卡片列表 + data-label
  key-value + 可展开）、`ModalSheet`（桌面居中 dialog / 移动端 bottom sheet，Esc/backdrop/焦点归还/
  body scroll lock/safe-area）、`ConfirmDialog`（危险操作二次确认）、`AdminState`（六态统一渲染）。
- **样式**：styles.css 的 next-phase 段全部重写为 CSS variables（消除了原先硬编码的 `#ddd/#555/#fef9c3`
  等字面量），新增 responsive/safe-area/100dvh/触控目标规则；`styleTokens.test.ts` 与
  `styles.theme.test.ts` 仍通过。
- **测试**：web 全量 485 通过（44 文件），其中新增 8 个测试文件 90+ 用例；typecheck 通过。
- 交互细节：e2e `next-phase.e2e.ts` 依赖 `page.on('dialog')` 处理确认框，因此 Experiments 生命周期
  危险操作（cancel/complete）保留 `window.confirm`（仍是二次确认）；LifeAdmin 的 override/delete 用
  自研 ConfirmDialog（e2e 不触达，可用组件级二次确认 + focus trap/aria）。

## FILES_CHANGED

- `packages/web/src/lib/admin.ts` — 冻结契约 API 全量封装 + `adminFailureKind` 状态映射 + `metricsExport` 下载。
- `packages/web/src/lib/innerThought.ts` —（新增）Inner Thought 模式偏好（localStorage）与 1~3 句截断。
- `packages/web/src/components/admin/DataList.tsx` —（新增）响应式表格/卡片列表。
- `packages/web/src/components/admin/ModalSheet.tsx` —（新增）可访问 modal / 移动端 bottom sheet。
- `packages/web/src/components/admin/ConfirmDialog.tsx` —（新增）危险操作确认对话框。
- `packages/web/src/components/admin/AdminState.tsx` —（新增）六态渲染 + `adminStateFromError`。
- `packages/web/src/components/LifeAdminPage.tsx` — 8-tab（+Weather）、tablist a11y、DataList、
  geocode 搜索、override/delete ConfirmDialog、天气/城市/行程区块。
- `packages/web/src/components/VoicePreferencesPage.tsx` — 错误态、quiet hours 标签、provider
  未配置态、长 provider 名换行。
- `packages/web/src/components/MetricsDashboardPage.tsx` — 分段 range、% 宽度条形图、移动端 series
  折叠、release compare、CSV/JSON 导出、distributions。
- `packages/web/src/components/ShadowRunsPage.tsx` — 可展开 diff（桌面左右 / 移动上下堆叠）、code block
  局部横滚。
- `packages/web/src/components/ExperimentsPage.tsx` — 操作分组 + danger-sep、confirm 二次确认、
  展开加载 report + audit 时间线。
- `packages/web/src/components/DecisionTracePage.tsx` —（新增）/admin/decision-trace 页。
- `packages/web/src/components/MessageItem.tsx` — InnerThoughtChip（消息上方折叠区，三模式）。
- `packages/web/src/styles.css` — next-phase 样式 token 化 + 全量响应式/触控/safe-area 规则。
- `packages/web/index.html` — viewport 增加 `interactive-widget=resizes-content`（iOS 软键盘）。
- 测试（新增）：`components/admin/adminKit.test.tsx`、`LifeAdminPage.test.tsx`、
  `MetricsDashboardPage.test.tsx`、`ShadowRunsPage.test.tsx`、`ExperimentsPage.test.tsx`、
  `DecisionTracePage.test.tsx`、`VoicePreferencesPage.test.tsx`、`MessageItem.thought.test.tsx`、
  `lib/innerThought.test.ts`。

## TESTS

- `cd packages/web && npm run typecheck` — PASS。
- `npm test`（vitest run，全量 web）— **485 passed / 44 files**（含既有 395 + 新增 90）。
- 覆盖：tablist/aria、卡片列表 data-label/展开、modal/sheet（Esc/backdrop/focus）、危险操作确认、
  loading/empty/error/flag-disabled/unauthorized/provider-unconfigured、长文本与 provider 名换行、
  图表 % 宽度（无固定 px）、inner thought 三模式与折叠、dark theme（既有 theme 测试仍绿）。

## PUBLIC_API

`lib/admin.ts` 新增（URL 与冻结契约 §2 一致）：

| 方法 | URL / method |
| --- | --- |
| `lifeCities` / `createCity` / `updateCity` | GET/POST `/api/admin/life/cities`；PATCH `/api/admin/life/cities/:id` |
| `lifeTravel` | GET `/api/admin/life/travel` |
| `geocodeSearch(query)` | POST `/api/admin/life/geocode/search` |
| `weatherStatus` / `weatherForecast` / `weatherRefresh` | GET `/api/admin/weather/status`、GET `/api/admin/weather/forecast`、POST `/api/admin/weather/refresh` |
| `metrics(days)` / `metricsDistributions(days)` | GET `/api/admin/metrics?days=`、GET `/api/admin/metrics/distributions?days=` |
| `metricsReleaseCompare(from,to)` | GET `/api/admin/metrics/release-compare?from=&to=` |
| `metricsExport(format)` | GET `/api/admin/metrics/export?format=csv\|json`（blob 下载） |
| `experimentReport(id)` / `experimentHistory(id)` | GET `/api/admin/experiments/:id/report`、`/history` |
| `decisionTraces(limit)` / `decisionTrace(batchId, revision?)` | GET `/api/admin/decision-trace/recent`、`/api/admin/decision-trace?batchId=&revision=` |
| `visibleThought(messageId, signal?)` | GET `/api/thoughts/:messageId`（chat 侧，404=无 thought） |

新增类型：`LifeCity`、`TravelState`、`WeatherCondition/Snapshot/Forecast* /Daylight`、`WeatherStatus`
（UI 约定响应，见下）、`GeocodeMatch`、`MetricsDistribution`、`ReleaseMetricsComparison`、
`ExperimentReport`、`ExperimentHistoryEntry`、`VisibleThought`、`DecisionTrace`。
另：`adminFailureKind(error)` → `unauthorized | flag-disabled | provider-unconfigured | error`（UI 状态约定）。

## MIGRATION_NEEDS

无（纯前端；数据库 schema 由 Agent A/B/C 的 migration 负责，与 UI 无关）。

## ENV_NEEDS

无新增环境变量。Feature flags 沿用冻结清单（默认 OFF）；页面在对应 flag 关闭时按约定显示
flag-disabled 状态（见 KNOWN_RISKS 的消息约定）。

## INTEGRATION_STEPS

1. **新页面路由挂载（AppShell.tsx，Integration 操作）**：
   - `import DecisionTracePage from './components/DecisionTracePage.js';`
   - `const isDecisionTrace = path === '/admin/decision-trace';`
   - `{route === 'admin' && isDecisionTrace && <DecisionTracePage />}`（并把它排除在既有
     `!isLifeAdmin && !isMetrics && !isShadow && !isExperiments` 的 AdminPanel 分支之外）。
   - Weather/Cities/Travel 已内置为 LifeAdmin 的 Weather tab（`/admin/life`），无需独立路由；
     若日后要独立页 `/admin/weather`，可复用 `WeatherSection`（当前未导出，可在 notes 协调后导出）。
2. **API 契约核对（后端 Agent A/B/C 落地时）**：
   - `/api/admin/weather/status` 响应建议含：`{ enabled, provider: {name, configured, active},
     lastSnapshot, cacheAgeSec, fallback, daylight, forecast }`（`WeatherStatus` 为 UI 层约定，
     后端可按需分字段；forecast/daylight 也可走 `/weather/forecast` 单独提供，UI 会合并）。
   - 错误语义约定：401/403 → unauthorized；消息含 `disabled|未启用|ENABLED` → flag-disabled；
     含 `configured|未配置|provider` → provider-unconfigured；其余 error。后端按此返回 message 即可。
   - `/api/admin/life/geocode/search` 未配置时返回 400 + message 含"未配置"；成功返回
     `{ matches, provider, configured }`。
   - `/api/thoughts/:messageId` 无 thought 时返回 404（UI 静默）；可见性只下发 `visibility=user` 的。
3. **Inner Thought UI 依赖**：chat 侧仅消费 `GET /api/thoughts/:messageId`（visible thought）。
   无需事件/SSE：每条 sent 的 assistant 消息渲染时拉取一次；流式生成期间不请求，状态到位后自动出现。
   如需"生成中"态，可后续在 `VisibleThought.status = generating` 时由服务端推送（本轮 UI 不阻塞）。
4. **e2e 兼容**：`next-phase.e2e.ts` 已核对——`life-location-list` 单元格、`shadow-run-count`、
   `voice-quiet-hours`、`.metrics-category table`、`experiment-table` 行内按钮与 `window.confirm`
   流程全部保持；Playwright 默认 1280 视口下 DataList 为桌面表格形态。
5. **样式入口**：所有新样式在 `packages/web/src/styles.css` 内（`.admin-page` 作用域），未新增 CSS
   文件、未改 main.tsx。

## KNOWN_RISKS

1. **Experiments 危险操作二次确认用 `window.confirm`**（而非 ConfirmDialog）：e2e 用
   `page.on('dialog')` 驱动确认框，改动会破坏 `next-phase.e2e.ts`。若后续要求组件级对话框，
   需同步改 e2e。LifeAdmin 的 override/delete 已用组件级 ConfirmDialog。
2. **`adminFailureKind` 是消息关键词启发式**：后端 message 文案若不匹配约定模式，状态会降级为
   error（仍显示原文）。建议后端按约定文案返回。
3. **`WeatherStatus` 响应形状是 UI 约定**：冻结契约只冻结了 snapshot/forecast/daylight 类型，
   status 端点形状未冻结，Integration 需与 Agent B 对齐（见上）。
4. **Inner thought 无服务端 flag 下发**：flag OFF 时 `/api/thoughts/:id` 404 → UI 静默不渲染，
   用户本地模式偏好保留；恢复后自动出现。折叠/展开的高度变化只在用户交互时发生，虚拟列表测量与
   scroll anchor 不受影响（App.tsx 的 ResizeObserver 会处理贴底态增长）。
5. **Metrics release-compare 的"上一区间"由后端决定**：UI 只传当前窗口 `from/to`（浏览器本地日期，
   近似 LIFE_TIME_ZONE），后端返回 current+previous 两组聚合。
6. **移动端 tab strip 为 sticky**：在 `≤680px` 吸顶并横向滚动；与 `admin-page` 顶部 safe-area
   内边距配合，未发现遮挡。若 Integration 引入全局 admin 顶栏，需复查 z-index（当前 10）。
7. **`.data-list` 行展开使用本地 state**（非受控），切换 section 后展开态重置——符合预期。
8. **禁改文件复核**：`AppShell.tsx`、`App.tsx`、`chatViewState.ts`、`e2e/*`、`docs/*`、
   `packages/server/*` 未改动（`git diff 基线分支 --stat` 可复核）。
