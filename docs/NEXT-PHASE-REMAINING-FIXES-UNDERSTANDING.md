# SOOYA 剩余问题修复方案 — 理解确认文档

> 基线：`integration/next-phase-final` / PR #83 / HEAD `17a1426` / migration v29 / CI 已通过
> 依据：《SOOYA当前版本剩余问题修复方案 (1).md》
> 状态：**已确认（2026-08-08）**——用户对整体理解确认，并按 6 点修正；修正内容见第十六条。确认后开始改代码。
> 本文件仅记录理解，不包含任何代码修改

---

## 一、本轮最终目标

把 `integration/next-phase-final`（PR #83，migration v29，CI 已绿）上的**审查剩余问题**修完：

- 以"单用户陪伴"为唯一标准**收简产品边界**
- **删除的系统保持删除**、**核心稳定系统零重构**
- 补齐**旧数据兼容**与**鉴权正确性**
- Final HEAD 重跑全量门禁 + GitHub CI
- 重写 PR #83 正文与交付文档（单一最终状态）
- 全部通过后 READY TO MERGE

**不是新功能轮，是收口轮。**

---

## 二、必须删除或保持删除

保持删除（本轮不恢复、不重做）：

- Experiments（Service/Repo/API/UI/rollout/report/history/flag）
- Shadow Mode（Service/Repo/API/UI/runtime/flag）
- Geocoding 产品层（Provider/service/API/Admin 搜索/GPS/经纬度管理）
- Decision Trace（页面/API/persistence/flag）
- Metrics release comparison / CSV export / JSON export / A/B 页面
- v29 已 DROP 的 5 张表（experiments / experiment_assignments / experiment_events / shadow_runs / decision_traces）

UI、路由、flag、文档中这些系统的残留描述全部清干净。

---

## 三、必须保留、禁止重构的核心系统

| 系统 | 禁止触碰的语义 |
|---|---|
| ReplyCoordinator | timeout retry / partial reply / failure card / publishing race protection |
| Memory | 完整生命周期（create/recall/update/supersede/archive/delete/correction） |
| Voice V2 | transcript 一致性 / semantic guard / AbortSignal / revision fence / TTS fallback |
| Life V2 | sleep / plan / thread / continuity / anti-repeat |
| Proactive | ReplyCoordinator 路径 / sent-once / quiet hours / dedupe |
| Visible Thoughts | 生命周期与 ThoughtSafetyFilter（**只改前端调用通道**） |
| Backup / Restore | 不动 |
| rollback preflight / normalize | 不动 |
| Scroll Anchor restore | 不动 |
| provider fallback / auth 边界 | 不动 |

**只修方案列出的剩余问题。**

---

## 四、Location 最终应该 / 不应该是什么

**应该是**（三件事，全部走现有表）：

```text
当前城市          life_cities
当前生活地点      life_locations / life_location_state / life_location_visits
地点之间移动      travel_state（防瞬移）
```

**不应该**：

```text
地图 / GPS / 地址 / POI / 导航 / 路线规划 / 经纬度编辑 / 多国家多时区管理
```

DB 历史列（lat / lng / country / time_zone）可保留兼容，但**不扩散为产品能力**。

---

## 五、城市功能最终程度

- fresh DB 默认 **宁波 / 浙江 / 中国 / Asia/Shanghai**；restart 保持；管理端可改
- Admin 城市设置只保留：**城市名 + 地区（可选）**；国家固定中国、时区固定 Asia/Shanghai，**UI 不要求用户输入国家/时区/坐标**
- 切换城市唯一入口：`LocationService.setActiveCity()`（清 movement、迁移 builtin/generated 归属、key/id 稳定、current 有效、Weather 跟随）
- 中国城市（宁波/杭州/上海/北京）统一 Asia/Shanghai
- **运行时统一 Asia/Shanghai，不保留多城市多时区运行语义**：`timeZoneFor` 恒返回注入时区（不读 location/city 的 time_zone）；历史 DB 时区字段仅兼容保留，不参与运行语义

---

## 六、Weather 最终数据流

```text
active city (name + region + country)
  → WeatherService（唯一业务入口，不感知坐标）
  → Provider adapter（内部 city→坐标，仅 provider 内部）
  → 缓存键 country|region|city（城市隔离，不串）
  → 失败链：联网查询 → 同城市缓存 → unknown
  → WorldContext / Life 评分 / Chat 只消费结果
```

不建独立 Geocoding service / API / 搜索；后续换支持城市名直查的 provider 只替换 adapter，不改 SOOYA 领域模型。

---

## 七、Open-Meteo 内部坐标处理

- **可以**存在于 `core/weather/provider.ts` 的 OpenMeteo adapter 内部（上一轮已实现：内部 geocoding 端点解析 + 实例级缓存）
- **绝对不能知道坐标的层**：Location、WorldContext、DB schema 语义、Admin API、用户设置、Metrics、Thoughts
- 历史 lat/lng DB 列**不删除**（兼容保留），但业务层/API/UI/Location/WorldContext **不得依赖或暴露坐标**：`LifeLocation` 领域类型与 `toLifeLocation` 映射剥掉 lat/lng，Admin API 与 Web `AdminLifeLocation` 类型同步去除（DB 列保留）

---

## 八、travel_state 语义

**日常地点之间的移动状态（防瞬移）**，不是旅游系统。

- DB 表名 / 结构保留
- UI 文案「行程」→「移动中」（当前 LifeAdminPage:537 仍是「行程」，需改）

---

## 九、Visible Thoughts 当前真正要修什么

**唯一实质问题：前端用错鉴权通道。**

- 现状：`MessageItem.tsx:206` 走 `adminApi.visibleThought()`（带 Admin token）→ 在 `WEB_CHAT_TOKEN` 部署下普通用户 401
- 后端路由本身已用 chat token（`requireChatToken`）✅
- 修复：
  1. `packages/web/src/lib/api.ts` 新增 `visibleThought(messageId, signal)`（普通 chat API，自动带 `x-sooya-token`）
  2. `MessageItem.tsx` 改用 `api.visibleThought()`
  3. 测试：有 chat token 无 admin token → 200；缺 chat token → 401
  4. E2E：Chat Token 登录 → assistant reply → Visible Thought 正常显示（**需确认 mock-model 是否支持 thought 请求，见第十六条-5**）

---

## 十、城市切换当前真正要修什么

**Admin PATCH 绕过 canonical 切换。**

- 现状：`life-admin.ts:235` 直接 `updateCity(id, body)`，`active: true` 不触发 `setActiveCity` 的 movement 清理 / 归属迁移
- 修复：patch 含 `active === true` 时调 `app.services.location.setActiveCity(id)`；其余字段仍走 `updateCity`
- `setActiveCity` 服务端实现上一轮已完整，**不动**
- API 级测试：宁波 active → 有 movement → 建杭州 → PATCH active=true → 断言 active=杭州 / movement 清空 / builtin 归属迁移 / key-id 不变 / current 有效 / Weather target=杭州

---

## 十一、旧 Location 数据 normalization 要解决的场景

现状：`seedBuiltins()` 对历史库只 `ensureDefaultCity()` 就 return（service.ts:251-254）。

需补**幂等** normalization：

1. **active city**：
   - **完全没有城市** → 新建宁波（浙江/中国/Asia/Shanghai，active）
   - **已有城市但无 active** → 优先恢复已有合法城市（先找 key='default' 或 name='宁波' 的已有城市，否则最早创建的城市），**不新增重复宁波、不覆盖用户选择**
   - 已有 active → 不动
2. **旧地点归属**：旧 builtin/generated 地点 `city_id IS NULL` → 绑 active city
3. **stable key**：**只回填能明确确认的历史 builtin/generated 地点**（家→home、家附近→neighborhood、街角咖啡店/咖啡店→cafe、社区公园/公园→park、图书馆→library、小区超市/超市→store）；不覆盖合法 key、不猜用户自建地点
4. **current state**：`life_location_state.location_id` 指向不存在/inactive → 优先 home，否则第一个 active location
5. **travel_state**：引用失效 location → 直接 clear
6. **幂等**：重复启动不重复建城/建点/改坏 key/改坏已修复 state

Migration fixture：v18/v23 插入真实旧 Location 数据，升级后断言 active city=宁波 / builtin 已绑 city / key 已补 / state 有效 / FK integrity / restart 一致。

---

## 十二、LIFE_TIME_ZONE 统一方式

**app.ts 显式注入 `env.LIFE_TIME_ZONE`，不依赖构造默认值"刚好是 Asia/Shanghai"。**

现状核对（HEAD 17a1426）：

| 组件 | 现状 | 动作 |
|---|---|---|
| WorldContextService | ✅ 已注入 (:272) | 不动 |
| LifeEngine/lifeSettings | ✅ 已注入 (:239) | 不动 |
| ContextBuilder | ✅ 已注入 (:302) | 不动 |
| LocationService | ❌ 构造无 options (:260) | 补 `{ timeZone: env.LIFE_TIME_ZONE }` |
| MetricsService | ❌ 构造无第三参 (:275) | 补 `env.LIFE_TIME_ZONE` |

测试：非默认时区下 Metrics local day / Location 本地小时 / WorldContext localDate 一致。

---

## 十三、Metrics 最终保留程度

只保留运行监控（底层全部保留）：

```text
reply success/failure/latency
voice success/failure/latency
proactive sent/blocked/failed
life failure
weather success/failure/stale
provider timeout/failure
count / mean / p50 / p95
```

**不保留独立 Metrics 分析平台**：
- 独立页面 `/admin/metrics` 与路由删除
- 基础指标区块**收进 AdminPanel「概览」section**（运行状态与资源）
- MetricsService / repo / distributions（p50/p95）底层全部保留
- 删除/不恢复：release comparison、experiment analysis、CSV/JSON export、A/B 页面

---

## 十四、不碰的稳定模块（只跑回归）

ReplyCoordinator、Voice 全链路、Memory 生命周期、Life V2 语义、Proactive 路径与 sent-once、Visible Thoughts 生命周期/安全过滤（只改前端调用通道）、Backup/Restore、rollback 工具、Scroll Anchor、provider fallback、auth 边界。

---

## 十五、最终预计修改文件与修改点（修正版）

### Server 代码

| 文件 | 修改点 |
|---|---|
| `packages/server/src/app.ts` | ① Location 构造补 `{ timeZone: env.LIFE_TIME_ZONE }`；② Metrics 构造补 `env.LIFE_TIME_ZONE` |
| `packages/server/src/core/location/service.ts` | ① `seedBuiltins` 增加幂等 normalization（无城市才建宁波 / 有城市无 active 恢复已有 / key 回填明确 builtin/generated / city_id 绑定 / state 修复 / travel 清理）；② `timeZoneFor` 简化为恒返回注入时区（不读 location/city time_zone）；③ `ensureDefaultCity` 语义调整（仅在完全无城市时新建） |
| `packages/server/src/db/repos/location.repo.ts` | ① `LifeLocation` 领域类型去掉 lat/lng + `toLifeLocation` 不映射（DB 列保留）；② 可能加"恢复 active city"helper（宁波优先 / 最早创建） |
| `packages/server/src/routes/life-admin.ts` | PATCH cities/:id：`active === true` → `setActiveCity(id)`，其余字段走 updateCity |

### Server 测试

| 文件 | 修改点 |
|---|---|
| `packages/server/test/location-city.test.ts` | 东京/纽约跨国时区测试改为中国城市（杭州/上海/北京）统一 Asia/Shanghai；`timeZoneFor` 恒 Asia/Shanghai 断言；"有城市无 active 恢复已有"场景 |
| `packages/server/test/location-normalize.test.ts`（新） | normalization 各场景（无城市建宁波 / 有城市无 active 恢复 / key 回填 / city_id 绑定 / state 修复 / travel 清理）+ 幂等 |
| `packages/server/test/migration-upgrade.test.ts` | v18/v23 fixture 插入真实旧 Location 数据（city_id NULL / 无 key / 失效 state / 失效 travel），升级 + 启动 app 两段式断言 |
| `packages/server/test/thoughts.test.ts` | Visible Thoughts chat-token auth：有 chat token 无 admin token → 200；缺 chat token → 401 |
| `packages/server/test/weather.test.ts` | 城市缓存隔离：不同城市键不串、失败只回本城缓存 |
| `packages/server/test/metrics.test.ts` | 显式时区注入断言（LIFE_TIME_ZONE 非默认时验证 local day） |

### Web

| 文件 | 修改点 |
|---|---|
| `packages/web/src/lib/api.ts` | 新增 `visibleThought(messageId, signal)`（普通 chat API，自动带 x-sooya-token） |
| `packages/web/src/components/MessageItem.tsx` | `adminApi.visibleThought` → `api.visibleThought` |
| `packages/web/src/components/LifeAdminPage.tsx` | ① 城市表单收简（只留名称 + 地区可选，去掉国家/时区输入，固定中国/Asia/Shanghai）；②「行程」→「移动中」 |
| `packages/web/src/components/LifeAdminPage.test.tsx` | 城市 UI 断言更新（不要求时区/国家、默认中国）；文案断言 |
| `packages/web/src/components/MetricsDashboardPage.tsx` | 不再作为独立页：改造为概览内嵌的 MetricsSummary 区块（聚合 + p50/p95 简化展示） |
| `packages/web/src/AppShell.tsx` | 删除 `/admin/metrics` 独立路由分支 |
| `packages/web/src/components/AdminPanel.tsx` | 「概览」section 嵌入基础 Metrics 区块 |
| `packages/web/src/components/MetricsDashboardPage.test.tsx` | 改为概览 Metrics 区块测试 |
| `packages/web/src/lib/admin.ts` | `AdminLifeLocation` 类型去掉 lat/lng（与后端 API 对齐）；metrics 方法保留 |

### E2E

| 文件 | 修改点 |
|---|---|
| `e2e/next-phase.e2e.ts` | ① Chat Token 登录 → assistant reply → Visible Thought 显示；② 宁波 → Admin 切杭州 → active city / movement 清理 / Weather target / restart 保持；③ metrics 断言改走概览页 |
| `e2e/mock-model.mjs` | 增加 thought 生成的最小必要响应分支（如当前缺失） |

### 文档 / GitHub

| 文件 | 修改点 |
|---|---|
| `docs/NEXT-PHASE-DELIVERY.md` | 重写为单一最终状态（删除旧系统冲突描述；记录 Final SHA / tests / migration / CI run id / rollback 程序） |
| PR #83 正文 | `gh pr edit` 重写（去 Geocoding/Shadow/Experiments/Decision Trace/compare/export/旧测试数） |
| `.env.example` | 仅核对（当前已无残留 ✅） |

### 明确不动的文件

ReplyCoordinator、Voice 全链路、Memory、Life V2 语义、Proactive、Thoughts 生命周期/安全过滤（只改前端调用通道）、Backup/Restore、rollback 工具、Scroll Anchor、provider fallback、auth 边界、`travel_state` 表结构、`life_locations` 表结构（lat/lng 列保留）。

## 十六、方案与代码的冲突 / 歧义（已确认修正）

用户已确认整体理解正确，并按以下 6 点修正：

| # | 原疑点 | 确认结论 |
|---|---|---|
| 1 | Metrics 时区注入实际缺失 | **确认补**：Metrics/Location 构造显式注入 `env.LIFE_TIME_ZONE` |
| 2 | Metrics 独立页归属 | **不保留独立 Metrics 分析平台**：基础 Metrics 收进现有「概览/运维」，底层 p50/p95 保留 |
| 3 | 东京/纽约测试删改边界 | **运行时统一 Asia/Shanghai，不保留多城市多时区运行语义**；历史 DB 字段可留兼容 |
| 4 | normalization 触发点（两段式 fixture） | 确认；且修正语义：**只有完全没有城市时才新建宁波**；已有城市无 active → 恢复已有合法城市（不重复建宁波、不覆盖用户选择）；stable key 只回填能明确确认的历史 builtin/generated 地点 |
| 5 | Visible Thoughts E2E mock-model | **确认**：可增加最小必要响应分支 |
| 6 | PR #83 正文 + Delivery 文档 | **确认属于本轮**：Final HEAD 后全部更新 |

附加确认：历史 lat/lng DB 列无需删除，但**业务层/API/UI/Location/WorldContext 不得依赖或暴露坐标**。

## 十七、最终检查清单（验收依据）

- [ ] Visible Thoughts 用户请求不再使用 Admin API
- [ ] Chat Token 部署下 Visible Thoughts 正常
- [ ] Admin 切换城市统一走 `setActiveCity`
- [ ] 城市切换清理 movement
- [ ] builtin/generated location 跟随 active city
- [ ] old Location 数据完成 normalization
- [ ] normalization 幂等
- [ ] 默认城市宁波（仅完全无城市时新建）
- [ ] 已有城市无 active → 恢复已有合法城市（不重复建宁波、不覆盖用户选择）
- [ ] 运行时统一 Asia/Shanghai（timeZoneFor 恒注入时区，多时区运行语义不保留）
- [ ] normalization 幂等
- [ ] Admin 城市 UI 不要求填时区/国家/坐标
- [ ] 不提供地图 / GPS / POI / 经纬度管理
- [ ] travel_state 用户语义仅为「移动中」
- [ ] Weather identity = active city
- [ ] Weather cache 跨城市不串
- [ ] Metrics 显式注入 LIFE_TIME_ZONE
- [ ] Location 显式注入 LIFE_TIME_ZONE
- [ ] 无独立 Metrics 分析平台（基础指标收进概览）
- [ ] 业务层/API/UI/Location/WorldContext 不依赖不暴露坐标（DB 列保留）
- [ ] PR #83 正文已更新
- [ ] Delivery 文档无旧系统冲突描述
- [ ] .env.example 无已删除功能残留
- [ ] 稳定核心模块无回归
- [ ] Final HEAD CI 全绿
- [ ] 记录 Final SHA / tests / migration latest / CI run id
