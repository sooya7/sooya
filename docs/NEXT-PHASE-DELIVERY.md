# SOOYA 当前版本 — 最终交付与运维指南

> 分支：`integration/next-phase-final`（PR #83）
> 数据库 schema：v29（`visible_thoughts` … `weather_daylight`；v29 清理已删除系统的表）
> 状态：**READY TO MERGE**（Final HEAD 全部门禁 + GitHub CI 全绿）

---

## 1. 最终产品范围（单用户陪伴）

```text
ReplyCoordinator（可打断/合并/partial/failure card/restart recovery）
Voice V2（replace/complement/summary/read_aloud、语义守卫、TTS 回退）
Life V2（vitals/theme/plans/threads/events/continuity/anti-repeat）
Location（城市 + 生活地点 + 地点间移动防瞬移）
Weather（按 active city 联网查询，缓存按城市隔离）
WorldContext（城市/地点/天气/日照统一快照）
Memory（完整生命周期：create/recall/update/supersede/archive/delete/correction）
Proactive（统一走 ReplyCoordinator，sent-once）
Visible Thoughts（安全内心独白，chat-token 读取）
Metrics（基础运行监控：count/mean/p50/p95，收进 Admin 概览）
Scroll Anchor（移动端滚动恢复，retries=0 稳定）
Admin / Voice Preferences（现有信息架构）
```

## 2. 已删除的系统（v29 清理表，不恢复）

| 系统 | 说明 |
|---|---|
| Experiments | Service/Repo/API/UI/rollout/report/history/flag；`experiments` `experiment_assignments` `experiment_events` 已 DROP |
| Shadow Mode | Service/Repo/API/UI/runtime/flag；`shadow_runs` 已 DROP |
| Geocoding | Provider/service/API/Admin 搜索/GPS/经纬度管理（provider 内部城市解析除外） |
| Decision Trace | 页面/API/persistence/flag；`decision_traces` 已 DROP；安全上下文抽为 ThoughtContextProvider |
| Metrics release comparison / CSV / JSON export / A/B | 不恢复 |

## 3. 核心系统（稳定，禁止重构）

ReplyCoordinator、Voice V2、Life V2、Memory、Proactive 路径与 sent-once、Visible Thoughts 生命周期与安全过滤、Backup/Restore、rollback preflight/normalize、Scroll Anchor、provider fallback、auth 边界。

## 4. Feature Flags（全部默认 OFF；关闭行为与稳定版一致）

```env
WORLD_CONTEXT_ENABLED=false
LOCATION_MODEL_ENABLED=false
WEATHER_ENABLED=false
LIFE_ADMIN_UI_ENABLED=false
VOICE_PREFERENCES_UI_ENABLED=false
METRICS_DASHBOARD_ENABLED=false
VISIBLE_THOUGHTS_ENABLED=false
VISIBLE_INNER_MONOLOGUE_ENABLED=false
```

## 5. 灰度顺序（建议）

```text
Phase 1  Location ON（默认城市宁波，北京时间）
Phase 2  Weather ON（只影响评分，不主动报天气）
Phase 3  Voice Preferences / Metrics ON
Phase 4  Visible Thoughts ON（先 inner monologue，安全过滤生效后）
```

## 6. 回滚

- 任何模块 `flag OFF` 即回退，无需降 migration；
- v29 只删表不迁移数据：**回滚首选恢复升级前 DB backup + 旧 release**；次选 `rollback:preflight` + `rollback:normalize`；
- Weather/Location 关闭后 Life 回稳定行为；provider 故障一律 graceful degradation。

## 7. 最终验收记录（Final HEAD）

| 门禁 | 结果 |
|---|---|
| Server 全量测试 | ✅ 78 文件 / 737/737 |
| Web 全量测试 | ✅ 483/483 |
| typecheck / build | ✅ 0 error |
| E2E **retries=0**（本地 + CI 配置） | ✅ 98/98 |
| Migration fixtures | ✅ v14 / v18 / v23 / v28 → v29（含旧 Location 数据与启动 normalization 断言） |
| Migration rollback / preflight | ✅（preflight max v29） |
| Restart recovery | ✅ |
| GitHub CI | ✅ validation / e2e / audit / release+container 全绿 |

## 8. 回滚程序（首选）

1. 首选：恢复升级前 DB backup + 旧 release（`data/backups/`）
2. 次选：`rollback:preflight` 检查 pending reply/voice/proactive → `rollback:normalize` → 旧代码启动
3. v29 只删表不迁移数据：被删系统的表不存在，旧代码直接访问会失败，必须走 backup 恢复

---

# 9. 最终收口记录（《SOOYA最终收口实施方案-精简执行版》+ 历史完善项补全版）

## 9.1 删除的系统（完整删除，无简化版）

| 系统 | 代码 | 数据库 |
|---|---|---|
| Experiments | ExperimentService/Repo/API/UI、rollout/assignment/report/history、`EXPERIMENTS_ENABLED` | v29 DROP `experiments` / `experiment_assignments` / `experiment_events` |
| Shadow Mode | ShadowService/Repo/API/UI/runtime、`SHADOW_MODE_ENABLED` | v29 DROP `shadow_runs` |
| Geocoding | GeocodingProvider/service/API/Admin 搜索、GPS/经纬度管理 | —（无表） |
| Decision Trace | Admin 页面/API/history/persistence、`ADMIN_DECISION_TRACE_ENABLED`；安全上下文抽为 `ThoughtContextProvider` | v29 DROP `decision_traces` |

保留：Visible Thoughts（含 inner monologue + admin decision_summary thought）、Life V2、ReplyCoordinator、Voice V2、Metrics（count/mean/min/max/p50/p95）、Scroll anchor restore。

## 9.2 城市与时区

- fresh DB 默认 active city = **宁波 / 浙江 / 中国**，时区 `Asia/Shanghai`；restart 保持当前城市；管理端可修改
- 城市切换一致性：取消在途行程、builtin/generated 地点归属迁移（key/id 稳定）、current 保持有效、Weather/WorldContext 自动跟随
- `LIFE_TIME_ZONE` 显式注入 MetricsService/LocationService/WorldContextService

## 9.3 Weather 城市化

- 业务输入只允许 city + country；缓存按 `country|region|city` 隔离（旧城市缓存永不作新城市 fallback）
- open-meteo adapter 内部解析城市→坐标（geocoding 端点，属 provider 内部实现，不扩散到 Location/WorldContext/DB/Admin）
- 失败链：联网查询 → 同城市缓存 → unknown；不阻塞 Chat/Life/Proactive

## 9.4 本轮补齐

- **Proactive**：assistant 消息只经 `ReplyCoordinator.publishProactiveMessage` 持久化（sent-once 唯一索引语义保留）
- **Memory**：admin 编辑（re-normalized + FTS 同步）、用户纠正 supersede 旧事实、删除后不再召回
- **Metrics** 时区接线（`env.LIFE_TIME_ZONE`）

## 9.5 门禁记录（历史）

| 门禁 | 结果 |
|---|---|
| server 全量 | ✅ 77 文件 / 725/725 |
| web 全量 | ✅ 486/486 |
| typecheck / build | ✅ 0 error |
| E2E **retries=0**（本地 + CI 配置） | ✅ 94/94 |
| migration fixture v14/v18/v23/v28 → v29 | ✅ 10/10（含 DROP 表断言、FK integrity、保留表断言） |
| restart recovery / rollback preflight | ✅（preflight max v29） |
| Playwright retries | `retries: 0`（playwright.config.ts，本地与 CI 一致） |

## 9.6 回滚程序（历史）

1. 首选路径：恢复升级前 DB backup + 旧 release（备份在 `data/backups/`，自动/手动可用）
2. 次选：`npm run rollback:preflight` 检查 pending reply/voice/proactive；`npm run rollback:normalize` 规范化新状态后用旧代码启动
3. v29 只删表不迁移数据；降级时被删系统的表不存在，旧代码访问会失败——必须走 backup 恢复

## 9.7 Final SHA / CI

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
