# INTEGRATION-NOTES — Agent C（Metrics + Shadow + Experiments 完整版）

> Worktree: `sooya-observability`（branch `agent/metrics-experiments`）
> 依据：《SOOYA-下一阶段一次性完整收口与交付方案.md》§10/§11/§12 与 `docs/NEXT-PHASE-CONTRACTS.md` §1.4/§1.5/§2/§4/§5

## SUMMARY

- **Metrics 完整版（§10）**：分布统计（min/max/mean/p50/p95，直方图采样语义）、LIFE_TIME_ZONE 本地日期归档（禁止 UTC 切日）、Release comparison（双窗口聚合）、CSV/JSON 导出（只含指标，无私人正文）。
- **Shadow 完整版（§11）**：canonical 隔离修复（`canonicalVariantForSubsystem` 在 status=shadow 时永远返回 'control'；旧名 `variantForSubsystem` 保持兼容即获得修复），`shadowVariantForSubsystem` 供 shadow 采样取实验变体；只读语义回归全部通过。
- **Experiments 完整版（§12）**：rolloutPercent（10/25/50/100）deterministic sticky bucket（`hash(scopeKey + experimentId) % 100`，非每条消息随机；day scope 用本地日期）、实验报告（只写 observed difference，无 p 值）、实验历史（created/shadow/promoted/paused/resumed/completed/config_changed 全 audit）、生命周期约束（shadow_prerequisite / paused 立即 control / resume 保持 sticky）回归通过。
- 状态：typecheck 0 error；30 tests 全绿。**不宣称 READY TO MERGE**。

## FILES_CHANGED

| 文件 | 变更 |
| --- | --- |
| `packages/server/src/db/migrations.ts` | 末尾**临时追加** `version: 903, name: 'tmp_observability_full'`（测试用；最终 DDL 见 MIGRATION_NEEDS，Integration 统一重编号 v26/v27） |
| `packages/server/src/util/time-zone.ts` | 新增 `addDaysLocalDate(localDate, days)`（纯日历日期加减） |
| `packages/server/src/db/repos/metrics.repo.ts` | `record(category, metric, value, day)`（day 由服务按本地日期传入）；新增 `distributions(from,to)`、`exportRows(from,to)`；`MetricDailyRow` 增加 `min_value/max_value` |
| `packages/server/src/core/metrics.ts` | 构造新增 `timeZone`（默认 'Asia/Shanghai'）；新增 `localDay/todayLocal/distributions/distributionsBetween/releaseComparison/releaseComparisonDays/exportRows/toCsv/toJson`；`record/aggregates/daily` 全部切本地日期 |
| `packages/server/src/db/repos/shadow.repo.ts` | `ExperimentRow` 增加 `rollout_percent`；`create` 接受 `rolloutPercent`；新增 `rolloutBucket(id, scopeKey)`、`updateConfig(id, patch)`、`assignments(experimentId)`；`variantFor` 哈希改为 `scopeKey + experimentId`（契约 hash(scopeKey + experimentId)） |
| `packages/server/src/core/shadow.ts` | 新增 `canonicalVariantFor/shadowVariantFor/canonicalVariantForSubsystem/shadowVariantForSubsystem/updateConfig/report/history`；`variantFor/variantForSubsystem` 改为 canonical 语义（旧名兼容 = 修复）；生命周期事件补齐 `created/shadow/promoted/resumed/config_changed`（原 'started' 更名为 'promoted'，history 映射兼容旧 'started'）；rollout 门控 |
| `packages/server/src/core/experiment-report.ts` | **新增**：`ExperimentReport` / `ExperimentHistoryEntry` 类型与 `buildReport` / `buildHistory` 纯逻辑 |
| `packages/server/src/routes/admin.ts` | 新增 metrics/distributions、metrics/release-compare、metrics/export、experiments/:id/report、experiments/:id/history 路由；PATCH /experiments/:id 支持 name/variants/assignmentScope/rolloutPercent 配置变更 |
| `packages/server/test/metrics.test.ts` | 行键断言适配 min_value/max_value |
| `packages/server/test/experiments.test.ts` | 'started'→'promoted'；新增 rollout / updateConfig / report / history / admin API 用例 |
| `packages/server/test/shadow.test.ts` | 新增 status=shadow 时 canonical 决策 byte-equivalent 用例 |
| `packages/server/test/metrics-distribution.test.ts` | **新增**（单元级，内存库 + 显式时区） |
| `packages/server/test/metrics-export.test.ts` | **新增**（harness 级：CSV/JSON 导出 + 隐私 + admin 端点） |

## TESTS

`cd packages/server && npx vitest run test/metrics.test.ts test/shadow.test.ts test/experiments.test.ts test/metrics-distribution.test.ts test/metrics-export.test.ts` → **30 passed（5 files）**；`npm run typecheck` 0 error。

覆盖矩阵（全部通过）：

- p50/p95/min/max/mean 正确（含重复桶、跨日合并直方图）
- 本地日期跨日边界（2026-08-08T16:30Z → 本地 08-09；Asia/Shanghai 与 America/New_York 对照）
- release compare（latency 均值 100 vs 200、failure 率 0.1 vs 0.3；releaseComparisonDays 默认窗口）
- CSV/JSON 导出无消息正文/地址（'晚安'、'北京市朝阳区望京SOHO…' 均不在导出中）；CSV 转义
- shadow 状态时 canonical == control（engine tick 结果 JSON 字节级一致 + 服务层断言）
- rollout sticky bucket 确定性（同 (scopeKey, experimentId) 桶值可复现、重复读取 sticky、shadow 采样门控、100% 恒入组）
- paused 立即 control / resume 保持 sticky（既有回归）
- report 只写 observed difference（字段白名单断言，无 pValue/significant）
- history 完整（created/shadow/promoted/paused/resumed/config_changed/completed + legacy 'started' 映射）
- 只读语义回归（shadow 失败被吞、flag off 零行、admin 鉴权）全部通过

## PUBLIC_API

### MetricsService（`core/metrics.ts`）
```ts
new MetricsService(repo, clock = () => new Date(), timeZone = 'Asia/Shanghai')
record(category, metric, value = 1): void            // 不变签名；切日改本地日期
aggregates(days = 7): MetricAggregate[]              // 不变签名；本地日期窗口
daily(days = 7): MetricDailyRow[]                    // 不变签名
distributions(days = 7): MetricsDistribution[]       // 新增
distributionsBetween(fromDate, toDate): MetricsDistribution[]   // 新增
releaseComparison(currentFrom, currentTo, previousFrom, previousTo): ReleaseMetricsComparison   // 新增
releaseComparisonDays(currentDays = 7, previousDays = 7): ReleaseMetricsComparison               // 新增
exportRows(days = 7): MetricExportRow[]              // 新增
toCsv(rows): string  /  toJson(rows): string         // 新增
localDay(at: Date): string  /  todayLocal(): string  // 新增
```
统计语义：分位数 = 值四舍五入到 0.01 落直方图桶，p50/p95 = 累积计数首次到达 50%/95% 位置的桶值（最近样本语义）；mean = sum/count；min/max 来自 metric_daily 列（legacy NULL 行 COALESCE 0）。

### MetricsRepo（`db/repos/metrics.repo.ts`）
```ts
record(category, metric, value, day: string): void   // day 为本地日期（服务层计算，禁止 UTC 切日）
distributions(fromDate, toDate): MetricsDistribution[]
exportRows(fromDate, toDate): MetricExportRow[]      // { date, category, metric, count, sum, min, max }
```

### ExperimentService（`core/shadow.ts`）
```ts
new ExperimentService(repo, clock = () => new Date(), timeZone = 'Asia/Shanghai')
create(name, subsystem, variants, assignmentScope = 'day', rolloutPercent = 100): ExperimentRow
setStatus(id, status)                                // 事件：created(在 create 内)/shadow/promoted/paused/resumed/completed|cancelled
canonicalVariantFor(id): string | null               // shadow/paused → 'control'；running → rollout 门控 sticky；其余 null
variantFor(id)                                       // = canonicalVariantFor（旧名兼容）
shadowVariantFor(id): string | null                  // 仅 shadow 状态；rollout 未命中 → 'control'
canonicalVariantForSubsystem(subsystem)              // shadow 状态永远 'control'
shadowVariantForSubsystem(subsystem)                 // shadow 采样取实验变体
variantForSubsystem(subsystem)                       // = canonicalVariantForSubsystem（旧名兼容）
updateConfig(id, { name?, variants?, assignmentScope?, rolloutPercent? })   // 记录 config_changed
report(id, metrics?: MetricsAggregateReader): ExperimentReport | null       // 无 p 值
history(id): ExperimentHistoryEntry[]
```

### ExperimentRepo（`db/repos/shadow.repo.ts`）
```ts
create({ name, subsystem, variants, assignmentScope?, rolloutPercent? })    // rolloutPercent 非法值归一化 100
rolloutBucket(id, scopeKey): number                 // hash(scopeKey|id) % 100，确定性
updateConfig(id, patch)  /  assignments(experimentId)
```

### 新路由（已注册在 `routes/admin.ts`，全部 requireAdminToken）
```http
GET  /api/admin/metrics/distributions?days=7
GET  /api/admin/metrics/release-compare?currentDays=7&previousDays=7
GET  /api/admin/metrics/export?format=csv|json&days=7
GET  /api/admin/experiments/:id/report
GET  /api/admin/experiments/:id/history
PATCH /api/admin/experiments/:id  # 扩展：{ name?, variants?, assignmentScope?, rolloutPercent? }（rolloutPercent ∈ {10,25,50,100}）
```

### 契约类型（§1.4/§1.5 冻结形态，全部就位）
`MetricsDistribution` / `ReleaseMetricsComparison` / `ExperimentReport` / `ExperimentHistoryEntry`（事件 union 含超集扩展 'cancelled'，见 KNOWN_RISKS）。

## MIGRATION_NEEDS

本地临时 migration（`migrations.ts` 末尾 v903 `tmp_observability_full`）已包含以下全部 DDL，**Integration 统一重编号为 v26/v27** 并删除临时段（版本号由 Integration 独占，勿直接改）：

```sql
-- v26 metrics_distribution + release metadata
ALTER TABLE metric_daily ADD COLUMN min_value REAL;
ALTER TABLE metric_daily ADD COLUMN max_value REAL;

CREATE TABLE metric_distributions (
  date     TEXT NOT NULL,
  category TEXT NOT NULL,
  metric   TEXT NOT NULL,
  bucket   REAL NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, category, metric, bucket)
);

-- v27 experiment rollout
ALTER TABLE experiments ADD COLUMN rollout_percent INTEGER NOT NULL DEFAULT 100
  CHECK (rollout_percent IN (10, 25, 50, 100));
```

注意：`test/migration-rollback.test.ts` 断言版本号连续 1..LATEST_VERSION —— 在 v903 临时段存在期间该文件会失败（不在 Agent C 测试范围）；Integration 重编号回连续版本后自动恢复。

## ENV_NEEDS

无新增 env 变量。`MetricsService` 与 `ExperimentService` 的第三构造参数 `timeZone` 默认 'Asia/Shanghai'（与 `env.LIFE_TIME_ZONE` 默认一致）；**建议 Integration 在 app.ts 直接传 `env.LIFE_TIME_ZONE`**，保证指标切日与 WorldContext 本地日完全一致（不推荐另设 METRICS_TIME_ZONE，避免两个时区来源漂移）。

## INTEGRATION_STEPS

1. **app.ts 接线（唯一必需构造变更）**：
   ```ts
   const metrics = new MetricsService(repos.metrics, opts.clock, env.LIFE_TIME_ZONE);
   const experiments = new ExperimentService(repos.experiments, opts.clock, env.LIFE_TIME_ZONE);
   ```
   （当前 `new MetricsService(repos.metrics, opts.clock)` 等两参构造仍兼容，但不会传时区。）
2. **engine.ts 变体消费迁移（消费点替换说明，勿在本 worktree 改）**：
   - `src/core/life2/engine.ts:365` `variantForSubsystem('life.continuity_weight')` → `canonicalVariantForSubsystem('life.continuity_weight')`
   - `src/core/life2/engine.ts:366` `variantForSubsystem('life.anti_repeat_window')` → `canonicalVariantForSubsystem('life.anti_repeat_window')`
   - 说明：即使不改名也已获得修复（旧名 = canonical 语义），改名仅作意图澄清；若未来要给 shadow 采样接实验变体，用 `shadowVariantForSubsystem`。
3. **Migration 重编号**：v903 临时段 → v26（metric_daily 列 + metric_distributions 表）/ v27（experiments.rollout_percent），删除临时段；随后全量测试套件可跑。
4. **Admin API**：新路由已注册于 `routes/admin.ts`（清单见 PUBLIC_API），无需额外接线；`GET /api/admin/experiments/:id/report` 内部已注入 `repos.metrics` 作为聚合读取器。
5. **报告口径确认**（如与产品预期不符请反馈）：samples/control/treatment 来自 experiment_assignments 行数（out-of-bucket 用户不落分配行，因此 rollout<100 时 control 计数为 0）；observedDifference = 实验窗口（created_at 本地日起 → 当前本地日）与实验前等长基线窗口的同分类指标均值对比；两窗口缺任一数据则跳过该指标。

## KNOWN_RISKS

1. **migration-rollback.test.ts 在 v903 期间失败**：版本连续性断言（1..LATEST_VERSION），Integration 重编号后恢复（不在本代理测试范围）。
2. **legacy metric_daily 行（v21 时代）min_value/max_value 为 NULL**：distributions/exportRows 用 `COALESCE(..., 0)` 兜底；无直方图行时分位数为 0（新写入数据无此问题）。
3. **报告语义是“观察到的差异”**：无统计显著性（契约要求）；均值对比依赖指标落入实验关联分类（subsystem 首段，如 `life.continuity_weight` → category `life`）；同日内创建并结束的实验，基线窗口会整体前移一天（日粒度限制）。
4. **'cancelled' 事件为契约枚举的超集扩展**：`ExperimentHistoryEntry.event` 类型含 'cancelled'（v23 起就记录该原始事件，如实透传）；Integration 可决定冻结子集或映射。
5. **rollout 变更立即生效（gate-first）**：把 rolloutPercent 从 100 降到 50 时，桶值 ≥50 的 scope 会从实验组变 'control'（确定性、非随机；已在测试中明确此语义）；不破坏既有分配行的变体值。
6. **`variantFor` 哈希加入 experimentId**：与 v23 相比分配分布会变（契约明确 hash(scopeKey + experimentId)），属于预期行为变更。
7. **conversation scope 的 scopeKey 仍为 'main'**（沿用既有单用户行为，未改用 conversation id）；day scope 从 UTC 切日改为本地切日（预期修复）。
8. **`routes/admin.ts` 被修改**（metrics + experiments 两段）：与其他代理合并时注意该文件的冲突。
9. **导出列投影**（date/category/metric/count/sum/min/max）有意不含 last_updated，如产品需要可加列（无隐私影响）。
10. **`util/time-zone.ts` 新增 `addDaysLocalDate`**：纯新增导出，不影响 life2 既有导入。
