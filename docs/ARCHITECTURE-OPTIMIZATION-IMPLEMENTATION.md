# SOOYA 架构优化实施报告

基于 `SOOYA-CODEBASE-ARCHITECTURE-OPTIMIZATION-PLAN.md`，本分支完成了 A1～A4、B1～B5、C1～C4、D1～D4 的可运行落地，并保留现有产品行为与 SQLite 数据模型兼容性。

## 已落地内容

### A：关键链路稳定化

- `core/jobs/` 新增 `JobDefinition`、`JobContext`、注册表、执行器和 lane 配置。
- `JobWorker` 按 `critical/background/autonomous/maintenance` 独立泵取，critical 不再等待 autonomous 或 maintenance。
- Job timeout 对 cancellable handler 触发 `AbortController`，失败/retry 按契约写回 durable row。
- QQ webhook、消息入站、reply batch、模型、assistant persist、QQ delivery 和 proactive 都写入 bounded flow trace。
- 新增 Flow Trace repo、service、migration 47 和 Admin debug API。
- 增加 execution lane、flow trace、timeout、fault injection 和 critical-path contract tests；既有 restart / QQ exactly-once / proactive 回归继续保留。

### B：结构拆分

- bootstrap 已拆出 runtime factory 与 repository factory。
- feature routes 已按 persona、life、media、storage domain 拆分，旧 `features.ts` 只保留兼容装配入口。
- admin routes 增加 domain composition root，统一注册 continuity、operations、channel、capability 模块。
- AdminPanel 已拆出 AdminShell、AdminNavigation、导航/页面元数据；保持旧导出和路由行为不变。
- migration registry 已单独建立，历史 SQL 仍通过兼容入口提供，避免重写历史迁移。

### C：边界收敛

- `CapabilityPolicy` 和 `/api/admin/capabilities/policy` 已加入；能力组合在 Admin 概览展示。
- ContextSourcePipeline 已接入 Future、Relationship、Life、World，单个 source 失败不阻塞回复。
- Life v1/v2 统一实现 `core/life/public-contract.ts`，job 不再按具体 engine class 分支。

### D：研发流程

- 新增 `eventually` 与 `helpers/faults.ts`，contract test 不依赖隐式同步完成。
- 新增 `critical-path.contract.test.ts` 覆盖 lane 隔离、provider timeout、terminal trace 与持久投递幂等。
- 新增 `check:architecture`、`check:hotspots`、`select:tests`。
- 新增 Fast Gate；Full Gate 调整为 PR ready-for-review、main push 和手动触发，合并前质量门槛不降低。

## 文件与接口入口

| 目的 | 入口 |
| --- | --- |
| Job contract | `packages/server/src/core/jobs/types.ts` |
| Lane mapping | `packages/server/src/core/jobs/lanes.ts` |
| Flow trace | `packages/server/src/core/flow-trace.ts` |
| Capability policy | `packages/server/src/config/capabilities.ts` |
| Context sources | `packages/server/src/core/context-pipeline.ts` |
| Life public contract | `packages/server/src/core/life/public-contract.ts` |
| Feature route composition | `packages/server/src/routes/features.ts` |
| Admin route composition | `packages/server/src/routes/admin/index.ts` |
| Admin debug API | `packages/server/src/routes/flow-trace-admin.ts` |
| Architecture contract | `docs/ARCHITECTURE.md` |

## 验证记录

本分支已执行 server/web typecheck、lane/flow/reliability、feature/admin/life/QQ targeted tests、migration tests、boundary script 和 hotspot script。提交前会再执行完整 Server、Web、production build 与变更后的回归集合；CI 中 Fast Gate 与 Full Gate 分工不改变 Full Gate 的覆盖范围。

## 兼容与边界说明

历史迁移集合、核心 admin legacy handler 和 ContextBuilder 保留兼容实现，新的 registry/composition/pipeline 是稳定边界。后续新增 domain 必须进入新入口，不能把新逻辑重新堆回 legacy hotspot；hotspot 脚本已经对新入口设置预算，并把尚未搬迁的历史热点显式列为 legacy 观察项。
