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
109c0d4 test(e2e): cover world/admin/voice/shadow/experiment flows             22
8a530b6 docs: add delivery and rollout guide for next phase                    23

（上述为升级分支 `upgrade/world-context-admin-experiments` 的 23 个提交；
  最终收口在集成分支 `integration/next-phase-final` 上继续，见 §8/§9）
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

---

## 9. 集成分支提交记录（integration/next-phase-final，6fbf768 → c6bfae6）

```text
8cfdcec Merge agent/scroll-anchor            5423b9a Merge agent/ui-responsive
575967f Merge agent/visible-thoughts         3fd05f9 Merge agent/metrics-experiments
3de93c6 Merge agent/weather-world            04cfe5c/… Merge agent/location-complete
0fbfcd5 chore(db): unify migrations v24-v28
2c7bec3 feat(integration): wire env/app/routes/AppShell/world-context
8a95971 fix(integration): adapt tests to unified next-phase semantics
6530155 test(admin): adapt overview to anti-teleport travel semantics
c6bfae6 docs(qa): independent acceptance report
```

## 10. 状态

> **READY TO MERGE**（最终 HEAD 全部门禁 + GitHub CI 全绿，见 §11 收口记录）

---

# 11. 最终收口记录（《SOOYA最终收口实施方案-精简执行版》+ 历史完善项补全版）

## 11.1 删除的系统（完整删除，无简化版）

| 系统 | 代码 | 数据库 |
|---|---|---|
| Experiments | ExperimentService/Repo/API/UI、rollout/assignment/report/history、`EXPERIMENTS_ENABLED` | v29 DROP `experiments` / `experiment_assignments` / `experiment_events` |
| Shadow Mode | ShadowService/Repo/API/UI/runtime、`SHADOW_MODE_ENABLED` | v29 DROP `shadow_runs` |
| Geocoding | GeocodingProvider/service/API/Admin 搜索、GPS/经纬度管理 | —（无表） |
| Decision Trace | Admin 页面/API/history/persistence、`ADMIN_DECISION_TRACE_ENABLED`；安全上下文抽为 `ThoughtContextProvider` | v29 DROP `decision_traces` |

保留：Visible Thoughts（含 inner monologue + admin decision_summary thought）、Life V2、ReplyCoordinator、Voice V2、Metrics（count/mean/min/max/p50/p95）、Scroll anchor restore。

## 11.2 城市与时区

- fresh DB 默认 active city = **宁波 / 浙江 / 中国**，时区 `Asia/Shanghai`；restart 保持当前城市；管理端可修改
- 城市切换一致性：取消在途行程、builtin/generated 地点归属迁移（key/id 稳定）、current 保持有效、Weather/WorldContext 自动跟随
- `LIFE_TIME_ZONE` 显式注入 MetricsService/LocationService/WorldContextService

## 11.3 Weather 城市化

- 业务输入只允许 city + country；缓存按 `country|region|city` 隔离（旧城市缓存永不作新城市 fallback）
- open-meteo adapter 内部解析城市→坐标（geocoding 端点，属 provider 内部实现，不扩散到 Location/WorldContext/DB/Admin）
- 失败链：联网查询 → 同城市缓存 → unknown；不阻塞 Chat/Life/Proactive

## 11.4 本轮补齐

- **Proactive**：assistant 消息只经 `ReplyCoordinator.publishProactiveMessage` 持久化（sent-once 唯一索引语义保留）
- **Memory**：admin 编辑（re-normalized + FTS 同步）、用户纠正 supersede 旧事实、删除后不再召回
- **Metrics** 时区接线（`env.LIFE_TIME_ZONE`）

## 11.5 门禁（最终 HEAD）

| 门禁 | 结果 |
|---|---|
| server 全量 | ✅ 77 文件 / 725/725 |
| web 全量 | ✅ 486/486 |
| typecheck / build | ✅ 0 error |
| E2E **retries=0**（本地 + CI 配置） | ✅ 94/94 |
| migration fixture v14/v18/v23/v28 → v29 | ✅ 10/10（含 DROP 表断言、FK integrity、保留表断言） |
| restart recovery / rollback preflight | ✅（preflight max v29） |
| Playwright retries | `retries: 0`（playwright.config.ts，本地与 CI 一致） |

## 11.6 回滚程序（首选）

1. 首选路径：恢复升级前 DB backup + 旧 release（备份在 `data/backups/`，自动/手动可用）
2. 次选：`npm run rollback:preflight` 检查 pending reply/voice/proactive；`npm run rollback:normalize` 规范化新状态后用旧代码启动
3. v29 只删表不迁移数据；降级时被删系统的表不存在，旧代码访问会失败——必须走 backup 恢复

## 11.7 Final SHA / CI

- 最终提交：见本分支 HEAD（PR #83）
- GitHub CI：validation / e2e / audit / release+container 全绿后 READY TO MERGE

## 7. 已知问题

- **scroll restore 已结构性修复**：原 e2e flake（`e2e/navigation.e2e.ts:39`，完整 suite 的 mobile 上间歇失败）已通过 anchor-based 恢复（`ChatScrollAnchor { messageId, offsetFromViewportTop }`）根治——不再依赖绝对 scrollTop/固定 sleep/rAF 预算，QA 验证 E2E retries=0 全量 98/98 无 flake。完整根因分析与修复记录见 `docs/E2E-ISSUE-SCROLL-RESTORE.md`。

## 8. 门禁结果（最终 HEAD：集成分支 `integration/next-phase-final` @ c6bfae6）

| 门禁 | 结果 | 证据 |
|---|---|---|
| typecheck（server + web） | ✅ PASS | 0 error |
| server 全量测试 | ✅ PASS | 81 文件 / 748/748 |
| web 全量测试 | ✅ PASS | 45 文件 / 498/498 |
| build（server + web） | ✅ PASS | dist 产出 |
| E2E 全量 retries=0 | ✅ PASS | 98/98（QA 独立验证；navigation scroll-restore desktop+mobile 双绿、无 flake） |
| migration fixture | ✅ PASS | v14→latest / v18→latest / v23→latest |
| migration rollback | ✅ PASS | preflight 上限 v28、事务回滚 |
| 重启恢复 | ✅ PASS | restart-recovery 5/5 |
| feature-flag fallback | ✅ PASS | 11 个新 flag 默认全 false；metrics/shadow/thoughts flag-off 零写入/零行/零模型调用 |
| privacy | ✅ PASS | thoughts-safety 20/20、metrics-export 无私人正文、presenter 白名单审查 |
| Shadow/Experiment 语义 | ✅ PASS | status=shadow 时 canonical 恒 control（byte-equivalent 用例） |
| UI Compatibility Matrix | ✅ PASS | 8 页 × 9 维度（QA-REPORT.md 表格） |
| GitHub CI | ✅ PASS | PR #83 四个 job 全绿（validation / e2e / audit / release）；audit 修复 nanoid→3.3.18（GHSA-2v37-7h3g-55p8） |

> 独立 QA 结论（`QA-REPORT.md`）：**可以合入**。QA 阶段修复 4 个问题（D1 HIGH metrics 页契约白屏、D2 HIGH e2e CI flags 缺失、D3/D4 定位器适配）。
