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
| Server 全量测试 | ✅ 78 文件 / 738/738 |
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
