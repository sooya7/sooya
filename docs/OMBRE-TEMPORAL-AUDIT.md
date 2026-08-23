# Ombre Temporal Capability Audit（PR11）

> 结论先行：**在拿到一个可在线探测的 Ombre 实例之前，不实现统一的
> MemoryTemporalAdapter。** 本文档冻结审计问题清单与适配器接口；线下结论
> 以工具面（`mcp/tool-bridge.ts` 暴露的能力）为依据，标注为"待线上验证"。

## 1. 为什么需要审计（方案 §30-32）

生产默认 `MEMORY_BACKEND=ombre`。Legacy `memories` 表已具备 confidence /
expires_at / supersede 链，但 Ombre 侧是否有等价语义决定了统一 temporal
能力要做什么：若 Ombre 已有版本化事实，adapter 只是薄封装；若没有，强行
在本地表上补齐只对 legacy 生效，生产收益为零。

## 2. 审计问题清单（对线上实例逐项验证）

| # | 问题 | 验证方法 | 判定 |
|---|------|----------|------|
| Q1 | `anchor` 是否产生带时间戳的事实版本（而非覆盖）？ | 写入同一 subject 两次不同值，`trace` 查询 | 待验证 |
| Q2 | `hold`/`grow` 是否区分"纠正"与"随时间变化"？ | 两条矛盾表述后召回 | 待验证 |
| Q3 | 是否能表达 valid_from / valid_to？ | 工具 schema 检查 | 工具面未见时间窗参数 |
| Q4 | 召回是否会返回已被新事实替代的旧表述？ | supersede 场景后 recall | 待验证 |
| Q5 | `plan` 工具与 Commitment 引擎的职责重叠程度？ | 比对 plan 条目与 commitments 表 | plan 是语义记忆，非 scheduler（方案禁区 3） |
| Q6 | `dream` 整理是否会合并/丢失时间线版本？ | dream 前后 trace diff | 待验证 |

## 3. 适配器接口（已冻结，实现延后）

见 `packages/server/src/core/memory-temporal/adapter.ts`。任何实现必须同时
覆盖 Ombre 与 Legacy 两个后端，且 Legacy 侧的字段扩展（fact_key /
valid_from / valid_to / last_confirmed_at）在 adapter 落地时一并迁移。

## 4. 决策规则

- Q1-Q4 全部为"是" → 只做薄 adapter（读路径映射）。
- 任一为"否" → 分两层：运行时时效判断继续由 Future/Relationship 承担
  （已实现），Ombre 保持纯语义记忆，Legacy 侧字段扩展降为可选优化。
- 在生产开启任何依赖 Q1-Q4 的功能前，必须先用线上实例跑完本清单。

## 5. 当前状态

- 本阶段实现的所有时间轴能力（commitments / relationship / episodes）都
  不依赖 Ombre 的 temporal 语义 —— 它们是独立状态机，Ombre 只存"意义"。
- 因此审计不阻塞任何已交付功能；adapter 是否成为后续 PR 由 Q1-Q4 决定。
