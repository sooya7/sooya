# SOOYA 架构优化实施报告

基于 `SOOYA-CODEBASE-ARCHITECTURE-OPTIMIZATION-PLAN.md`，本分支完成了核心 A/B/C/D 能力的可运行落地，并完成 PR #135 合并前的运行语义收口；现有产品行为与 SQLite 数据模型保持兼容。

## 已落地内容

### A：关键链路稳定化

- `core/jobs/` 新增 `JobDefinition`、`JobContext`、注册表、执行器和 lane 配置。
- `JobWorker` 按 `critical/background/autonomous/maintenance` 独立泵取，critical 不再等待 autonomous 或 maintenance。
- Job timeout 明确区分 `abort` 与 `observe`；只有真正支持 cooperative cancellation 的任务才把 `AbortSignal` 传到底层 IO，不能安全中止的任务不会制造重叠 retry。
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
- ContextSourcePipeline 已接入 Future、Relationship、Life、World；pipeline 存在时它是权威输入，单个 source 失败不会再触发 legacy service fallback，也不阻塞回复。
- Life v1/v2 统一实现 `core/life/public-contract.ts`，job 不再按具体 engine class 分支。

### D：研发流程

- 新增 `eventually` 与 `helpers/faults.ts`，contract test 不依赖隐式同步完成。
- 新增 `critical-path.contract.test.ts` 覆盖 lane 隔离、provider timeout、terminal trace 与持久投递幂等。
- 新增 `check:architecture`、`check:hotspots`、`select:tests`。
- 新增 Fast Gate；Full Gate 覆盖普通 PR 创建、ready-for-review、reopened、synchronize、main push 和手动触发，并在 draft PR 上跳过实际 jobs。
- `JobDefinition.maxAttempts` 现在是注册后的默认 truth source；未知 job type 在已注册 worker 的 durable enqueue 入口直接拒绝。
- CapabilityPolicy 现在反映 Ombre read/write、QQ 配置和主动消息 effective 状态，并返回不可用原因。

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

本分支已执行 server/web typecheck、lane/flow/reliability、feature/admin/life/QQ targeted tests、migration tests、boundary script 和 hotspot script；收口变更还增加 context-source、job-timeout、capability-policy、CI-trigger contract tests。Full Gate 的最终绿色状态必须以 GitHub Actions 实际检查为准，不能只看本地记录或 PR 描述。

## 兼容与边界说明

历史迁移集合、核心 admin legacy handler 和 ContextBuilder 保留兼容实现，新的 registry/composition/pipeline 是稳定边界。后续新增 domain 必须进入新入口，不能把新逻辑重新堆回 legacy hotspot；hotspot 脚本已经对新入口设置预算，并对五个 legacy hotspot 建立 baseline + 2% 防增长门槛。
