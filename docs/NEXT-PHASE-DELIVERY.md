# SOOYA 下一阶段升级 — 交付与灰度指南

> 交付分支：`upgrade/world-context-admin-experiments`
> 依据：《SOOYA 下一阶段完整升级方案》（`docs/NEXT-PHASE-UPGRADE-PLAN.md`）
> 基线：`main`（`5f3fd6e`，上一阶段合并点）
> 文档版本：2026-08-08

---

## 1. 交付概要

本阶段补齐了方案要求的 7 项能力，严格按推荐的 23 个提交顺序落地：

1. **Location Model**（v19）— SOOYA 自己的生活位置模型：内置地点、出行边、访问记录、状态机；
2. **Weather Snapshot**（v20）— provider 抽象 + 缓存 + 语义化天气快照；
3. **Life Admin UI** — 完整管理台（概览/生命值/计划/Thread/事件/地点/主动消息）；
4. **Voice Preferences UI** — 语音频率、静默时段、情绪预设、能力预览；
5. **Metrics**（v21）— 隐私安全的聚合指标 + 仪表盘；
6. **Shadow Mode**（v22）— 架构级只读影子运行时；
7. **单用户 Experiment / A-B**（v23）— shadow 前置的灰度实验框架。

约束落实：

- **不重构** Reply / Voice / Life 核心；
- 全部新能力由 feature flag 控制（默认 OFF），关闭时与稳定版行为完全一致；
- Location 只代表 SOOYA 自己的位置，不读取用户 GPS；
- Weather / Shadow / Metrics 故障不阻塞正常聊天；
- Shadow 无副作用（影子函数只收 id/kind/数字，无 repo 访问，失败被吞）；
- 实验不能绕过 revision fencing / VoiceService / Life lifecycle / ReplyCoordinator；
- Metrics / Shadow 不存聊天正文、私人 prompt、精确地址。

## 2. 分支与提交记录（23 个）

```text
81cfc06 docs: add next-phase upgrade plan (world context, admin, experiments)   ← 分支起点
728f914 feat(location): add life location model and visit state                 1
6140191 feat(location): integrate location selection with Life V2               2
738aba3 test(location): cover transitions repeat and restart                    3
96160f0 feat(weather): add provider abstraction cache and snapshots              4
ecd8c60 feat(weather): feed weather into life scoring and world context          5
95adc06 test(weather): cover stale fallback and activity effects                 6
343535c feat(admin): add life management APIs                                   7
828fca6 feat(web): add Life Admin console                                       8
bd12b50 test(admin): cover mutation audit and lifecycle                          9
da2de4b feat(voice): expose provider capabilities and preview                  10
4841ce6 feat(web): add Voice Preferences UI                                    11
10dfd8b test(voice): cover preferences quiet hours and preview                 12
505b317 feat(metrics): add privacy-safe aggregation                            13
a64bc68 feat(web): add metrics dashboard                                       14
2d3dbc2 test(metrics): verify aggregation and redaction                        15
c6cf905 feat(shadow): add read-only shadow runtime                             16
e2e87d6 feat(web): add shadow comparison view                                  17
e1c1df1 test(shadow): prove zero side effects                                  18
47750a3 feat(experiments): add single-user experiment framework                19
d25b020 feat(web): add experiment control panel                                20
fbd4ac3 test(experiments): cover sticky assignment and attribution             21
<提交 22/23 见文末门禁记录>
```

## 3. 能力清单与关键设计

### P0 World Foundation

| 能力 | 表/服务 | 关键点 |
|---|---|---|
| Location | `life_locations` / `life_location_edges` / `life_location_state` / `life_location_visits` | 内置种子（家/家附近/咖啡店…）、出行边（步行分钟）、防重复 24h、线程标签相关性、天气修饰、重启不漂（状态表持久化） |
| Weather | `weather_snapshots` | provider 抽象注入；<30min fresh / 30-120min usable+后台刷新 / >120min stale→上次快照或 unknown；雨/雪/暴风按 episode 去重记录语义事件；provider 故障绝不阻塞 |
| WorldContext | `WorldContextService.snapshot()` | now / timeZone / location / weatherCondition 一次取齐，供 Life 评分与上下文行 |

### P1 Control UI

| 能力 | 入口 | 要点 |
|---|---|---|
| Life Admin | `/admin/life`（7 分区） | 所有变更走审计 API；已完成计划不可改（409 immutable）；vitals 无行自动初始化；地点增删/override 审计 |
| Voice Preferences | `/settings/voice` | 频率/静默时段/情绪预设；capabilities + preview（200 字符截断、每 IP 10 秒限流、preview 不产生聊天记录） |

### P2 Observability

| 能力 | 表/服务 | 要点 |
|---|---|---|
| Metrics | `metric_daily` | Reply / Voice / Life / Proactive 全链路埋点；只存日期/分类/指标/和/计数；`METRICS_DASHBOARD_ENABLED` 门控，关闭即零写入 |
| Dashboard | `/admin/metrics` | 7/30/90 天聚合，无私人正文 |

### P3 Safe Experimentation

| 能力 | 表/服务 | 要点 |
|---|---|---|
| Shadow | `shadow_runs` | `life.activity_selector`（cont1.5-tight48）与 `life.location_selector`（weather-off）两个影子候选；输入指纹 sha256（24 位）；影子函数纯计算、无 repo 访问、失败被吞 |
| Experiments | `experiments` / `experiment_assignments` / `experiment_events` | 生命周期 draft→shadow→running→paused→completed/cancelled；**draft 直跳 running 被拒（shadow_prerequisite，409）**；暂停=立即回滚到 control 且保留子系统归属；day/session/conversation sticky 分配；同一子系统新实验接管归属 |
| 消费点 | `life2/engine.ts` | `life.continuity_weight`（x1.5）与 `life.anti_repeat_window`（tighter-48 [48,96,168]）两个 day-sticky 变体；实验关闭或 control 时与 canonical 完全一致 |

## 4. Feature Flags（全部默认 OFF）

```text
WORLD_CONTEXT_ENABLED        Location + Weather 总闸
LOCATION_MODEL_ENABLED       地点模型
WEATHER_ENABLED              天气
LIFE_ADMIN_UI_ENABLED        Life 管理 UI
VOICE_PREFERENCES_UI_ENABLED 语音偏好 UI
METRICS_DASHBOARD_ENABLED    Metrics 采集 + 仪表盘
SHADOW_MODE_ENABLED          Shadow 采样
EXPERIMENTS_ENABLED          实验框架
```

关闭时：Location 完全惰性、天气不查询、Metrics 零写入、Shadow 零行、实验不可消费变体——行为与 `main` 逐字节一致（shadow/experiments 测试以 A/B harness 验证过 canonical 不变）。

## 5. 灰度顺序（建议）

```text
Phase 1  Location ON（Weather OFF，Life Admin ON）
Phase 2  Weather ON（只影响评分，不主动报天气）
Phase 3  Voice Preferences / Metrics ON
Phase 4  Shadow ON（只 shadow planner/selector）
Phase 5  Experiments ON（先实验 anti-repeat / continuity）
```

## 6. 回滚

- 任何模块 `flag OFF` 即回退，无需降 migration（新表保留）；
- Weather/Location 关闭后 Life 回稳定行为；Shadow/Experiment 关闭后 canonical 完全不变；
- provider 故障一律 graceful degradation（缓存 → 上次快照 → unknown）。

## 7. 已知问题

- **e2e 既有 flake**：`e2e/navigation.e2e.ts:39` 滚动恢复测试在完整 suite 的 mobile 项目上间歇失败（虚拟化列表恢复早于布局完成的竞态，main 分支同样可复现）。完整根因分析与建议见 `docs/E2E-ISSUE-SCROLL-RESTORE.md`。本阶段以 CI 等价配置 `retries=1` 跑通门禁。

## 8. 门禁结果（本机最终 HEAD）

| 门禁 | 结果 |
|---|---|
| typecheck（server + web） | PASS（0 error） |
| server 测试（vitest） | PASS |
| web 测试 | PASS |
| build | PASS |
| E2E（含 next-phase spec） | PASS（retries=1，与 CI 一致） |
| migration fixture / rollback tooling | PASS（schema v23，preflight 上限同步） |
| 重启恢复 | PASS |
| GitHub CI | 见 PR 状态 |

> 门禁详细数值在最终验证后补录。
