# Relationship Continuity — 冻结契约（PR6）

> 状态：**已冻结**。PR7 按此实现；改任何常量先改这里。
>
> Relationship 层回答一个问题：**你们之间现在还有什么没有结束。**
> 它不是好感度（禁止 love=85），只保存结构化的未完成关系状态。

## 1. 边界

进入 Relationship：连续多轮的共同话题、未解决的分歧、共同经历、持续玩笑、关心语境。
不进入：稳定偏好（Memory/Ombre）、SOOYA 自己的生活（Life）、带明确时间的事项（Commitment）。

## 2. 类型与生命周期（与代码 `core/relationship/types.ts` 一致）

```text
kind: open_topic | shared_experience | emotional_context | unresolved_issue
    | shared_interest | ongoing_joke | care_context

status: open → cooling → archived
       open → resolved（明确收尾）
       resolved → open（reopen，计 reopenCount）
```

## 3. Matching（新信号接入已有 thread 的判定，两级）

```text
score = 0.50 semantic(title embedding cosine)
      + 0.20 entity overlap(title tokens Jaccard)
      + 0.20 recency(7 天内 1.0，线性衰减到 28 天 0)
      + 0.10 kind compatibility(同 kind 1.0，兼容组 0.5，其余 0)

score >= 0.62 → touch 已有 thread（更新 lastTouchedAt / summary / salience）
否则           → 新建 thread
```

无向量时退化为 entity/recency/kind 三项（满分 0.5，恰好到不了阈值 → 新建），
宁可多开 thread 也不错并（错并比多开更伤关系连续性）。

## 4. Salience 衰减（按 kind 半衰期，禁止统一 TTL）

```text
unresolved_issue   21d     emotional_context 14d
care_context       14d     shared_experience 10d
shared_interest    10d     open_topic         7d
ongoing_joke        3d
```

```text
salience(t) = salience_last * 0.5 ^ (elapsed / halflife)
salience < 0.35 → cooling（不再注入 Context，可被 touch 唤醒）
salience < 0.15 → archived（历史，只读）
touch 时 salience = min(1, max(salience, 0.7) + 0.15)
```

## 5. 与 Commitment 的联动

- thread 可带 `linkedCommitmentId`（如"一起调试 PR"thread ↔ follow_up commitment）。
- 统一语义事件（§14）：action=completed/cancelled/rescheduled 同时发给两个 resolver；
  Relationship 侧把 rescheduled 视为 updated/progress，不建任何 rescheduled 状态。
- analyzer 的 `relationship_resolutions` 只能引用系统提供的 open thread id。

## 6. Context 注入

- 只注入 status=open 且 salience >= 0.35 的 thread，最多 3~5 条，按 salience 排序。
- 与 Memory block 做与 Future 相同的词面去重（Current relationship state > stale memory）。
- 与 Future 合计预算 min(12% inputBudget, 700 tokens)。

## 7. 禁区

- 禁止数值化好感度/信任度。
- 禁止 analyzer 在 flag 关闭时输出 relationship 字段（§7 schema 裁剪）。
- 禁止 resolved thread 长期泄漏进 Context（resolved_thread_leak_rate 是长期指标）。
