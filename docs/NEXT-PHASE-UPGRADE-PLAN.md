# SOOYA 下一阶段完整升级方案

> 基线：Interruptible Reply、Voice V2、Life V2、Proactive Coordinator 已完成收口  
> 当前 migration：v18  
> 建议分支：`upgrade/world-context-admin-experiments`

## 目标

补齐此前明确暂缓的能力：

1. 真实地点 / Location Model
2. Weather Snapshot
3. Life Admin 完整 UI
4. Voice Preferences 完整 UI
5. Metrics Dashboard
6. Shadow Mode
7. 单用户 Experiment / A-B Framework

整体链路：

```text
时间 + Vitals + Theme + Plan/Thread
          ↓
Location + Weather
          ↓
Life Selector / Planner
          ↓
Activity / Outcome / Event
          ↓
Proactive Candidate
          ↓
ReplyCoordinator
          ↓
Text / Voice / Image
```

实验链：

```text
Canonical
↓
Shadow
↓
Metrics
↓
Experiment
↓
灰度
```

---

## 一、基础原则

- 不重构当前 Reply / Voice / Life 核心。
- 新能力全部 Feature Flag 控制。
- Flag 全关时行为必须等价当前稳定版本。
- Location 默认表示 SOOYA 自己的生活位置，不自动读取用户 GPS。
- Weather/Shadow/Metrics 故障不能阻塞正常聊天。
- Shadow 永远无副作用。
- 实验不能绕过 revision fencing、VoiceService、Life lifecycle 或 ReplyCoordinator。

建议新增：

```env
WORLD_CONTEXT_ENABLED=false
LOCATION_MODEL_ENABLED=false
WEATHER_ENABLED=false
LIFE_ADMIN_UI_ENABLED=false
VOICE_PREFERENCES_UI_ENABLED=false
METRICS_DASHBOARD_ENABLED=false
SHADOW_MODE_ENABLED=false
EXPERIMENTS_ENABLED=false
```

---

# 二、Location Model

## 数据模型

```ts
type LocationKind =
  | 'home' | 'neighborhood' | 'cafe' | 'restaurant'
  | 'store' | 'park' | 'library' | 'mall'
  | 'transit' | 'work' | 'study' | 'venue'
  | 'outdoor' | 'other';

interface LifeLocation {
  id: string;
  name: string;
  kind: LocationKind;
  city?: string;
  region?: string;
  country?: string;
  timeZone?: string;
  lat?: number;
  lng?: number;
  tags: string[];
  indoor: boolean;
  visitWeight: number;
  source: 'builtin' | 'generated' | 'admin' | 'conversation';
  active: boolean;
}
```

当前地点：

```ts
interface LifeLocationState {
  locationId: string;
  arrivedAt: string;
  expectedLeaveAt?: string;
  sourcePlanId?: string;
  sourceActivityId?: string;
  confidence: number;
}
```

地点关系：

```ts
interface LocationEdge {
  fromId: string;
  toId: string;
  travelMinutes: number;
  mode: 'walk' | 'bike' | 'transit' | 'car' | 'unknown';
}
```

### migration v19

```text
life_locations
life_location_edges
life_location_state
life_location_visits
```

### LocationSelector

输入：

```text
activity
plan
current location
weather
vitals
recent visits
thread
time
```

评分：

- activity/location compatibility
- 路程成本
- continuity
- 天气适配
- 最近访问重复惩罚
- Thread 相关度
- 时间段适配

输出：

```ts
{
  locationId,
  reason,
  travelMode,
  scoreBreakdown
}
```

### API

```http
GET    /api/life/locations
GET    /api/life/location
POST   /api/admin/life/locations
PATCH  /api/admin/life/locations/:id
DELETE /api/admin/life/locations/:id
POST   /api/admin/life/location/override
```

Location override 必须写 audit。

### 验收

- plan 可以驱动地点变化；
- travel 有真实状态；
- 地点有 anti-repeat；
- 重启后位置不漂；
- ContextBuilder 只描述已有地点，不虚构地址。

---

# 三、Weather Snapshot

## Provider

```ts
interface WeatherProvider {
  current(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot>;
  forecast?(location: WeatherLocation, days: number, signal?: AbortSignal): Promise<WeatherForecast>;
}
```

不要把具体天气供应商写死进 LifeEngine。

## Snapshot

```ts
interface WeatherSnapshot {
  observedAt: string;
  condition: 'clear'|'cloudy'|'rain'|'snow'|'storm'|'fog'|'wind'|'unknown';
  temperatureC?: number;
  feelsLikeC?: number;
  humidity?: number;
  precipitationMm?: number;
  windKph?: number;
  provider: string;
  locationKey: string;
  stale: boolean;
}
```

### migration v20

```text
weather_snapshots
```

### 缓存策略

```text
<30 min      fresh
30-120 min   可使用，后台 refresh
>120 min     stale
provider fail → 用最近 snapshot
无 snapshot  → unknown
```

Weather provider 失败时 Life 必须继续运行。

### 对 Life 的影响

天气只是 modifier，不是硬规则：

```text
rain      → outdoor -30 / cafe-library +12
clear     → park-walk +15
very hot  → midday outdoor -25
snow      → home/cozy +8 / travel friction +15
```

最终仍由：

```text
vitals + plan + thread + location + weather
```

共同决定。

### Weather Event

只在有语义变化时记录：

```text
weather.started_raining
weather.cleared_up
weather.first_snow
weather.hot_day
```

不要每次 refresh 都制造 Life Event。

### Proactive

天气不能单独成为“报天气机器人”。

推荐链路：

```text
天气变化
+
生活活动发生偏移/结果
→ share candidate
```

例如：

```text
散步 → 下雨 → 跑进咖啡店
```

比“现在 22°C”自然。

---

# 四、WorldContextService

统一 Location + Weather：

```ts
interface WorldSnapshot {
  now: string;
  timeZone: string;
  location?: LifeLocation;
  previousLocation?: LifeLocation;
  weather?: WeatherSnapshot;
}
```

新增：

```ts
class WorldContextService {
  snapshot(): WorldSnapshot;
}
```

消费者：

```text
Life Planner
Life Selector
ContextBuilder
Proactive
Admin UI
Voice contextual delivery
```

---

# 五、Life Admin 完整 UI

页面：

```text
/admin/life
```

建议 7 个区域：

```text
Overview
Vitals
Plans
Threads
Events
Locations
Proactive
```

## Overview

重点回答：

```text
她现在在哪？
在干嘛？
为什么？
接下来准备干嘛？
```

展示：

- activity
- location
- weather
- mood
- theme
- vitals
- active plan/thread
- recent events

## Vitals

展示与趋势：

```text
energy
hunger
stress
social_need
loneliness
curiosity
comfort
focus
sleep_debt
```

支持小幅调整和 reset，全部写 audit。

## Plans

支持：

```text
create
edit before active
pause
cancel
reschedule
inspect outcome
```

completed 历史不允许直接篡改。

## Threads

支持：

```text
create
pause
resolve
archive
```

继续遵守 active thread 上限。

## Events

可按：

```text
activity/weather/location/conversation/plan/thread/proactive
```

过滤，并显示：

```text
plan → activity → outcome → event → proactive
```

## Locations

完整 CRUD、visit history、tags、indoor、weight、optional coordinates。

## Proactive

显示：

```text
candidate
blocked reason
sent
cancelled
user appeared
duplicate
mode
```

管理员不能绕过 Coordinator 强行发送。

---

# 六、Voice Preferences 完整 UI

页面：

```text
/settings/voice
```

## 用户设置

### 基础

```text
Voice enabled
默认音色
语速
最大语音时长
```

### 自动语音

```text
explicit only
low
medium
high
never
```

独立：

```text
auto complement
auto summary
proactive voice
```

### Quiet Hours

Voice quiet hours 与 Life silent hours 分开。

自动语音受 quiet hours 限制，用户明确要求语音时允许 override。

### 情绪

显示现有 emotion presets，允许高级用户调：

```text
speed
instructions
```

### Provider capability

新增：

```http
GET /api/settings/voice/capabilities
```

返回 provider 真正支持的：

```text
instructions
emotion enum
speed
abort
voices
```

UI 不显示 provider 不支持的控件。

### Preview

新增：

```http
POST /api/settings/voice/preview
```

要求：

- 字符限制；
- rate limit；
- 不创建聊天消息；
- 不进 memory/life；
- preview media 自动清理。

---

# 七、Metrics 数据层

在 Shadow/A-B 前先补观测。

新增：

```ts
MetricsService
```

不读取/存储完整聊天正文。

## Reply

```text
success/failure
interrupt
superseded
auto retry
partial
first visible latency
total latency
```

## Voice

```text
mode
success
fallback
cancel
naturalness rewrite
semantic rejection
TTS latency
duration
```

## Life

```text
plan create/complete/skip
thread create/resolve
activity diversity
location diversity
repeat penalty
weather deviation
```

## Proactive

```text
candidate
sent
blocked
user appeared cancel
reply conflict
duplicate
response
```

### migration v21

推荐：

```text
metric_daily
```

先做每日聚合，不引入外部时序数据库。

---

# 八、Metrics Dashboard

页面：

```text
/admin/metrics
```

面板：

```text
Reply
Voice
Life
Proactive
World
```

范围：

```text
7 days
30 days
current release
```

禁止展示私人正文、完整 spokenText、精确地址。

---

# 九、Shadow Mode

Shadow 定义：

```text
canonical 正常执行
+
shadow 只计算候选
+
不发布
+
不写真实状态
+
不触发 memory/proactive/push/media
```

第一版适合：

```text
Life activity selector
Location selector
Voice planner
Proactive policy
```

不建议第一版 shadow 整个聊天模型。

## ShadowContext

必须架构级只读，不能仅靠约定。

禁止依赖：

```text
MessageRepo.write
LifeRepo.write
Media.save
Push
Proactive publish
Memory.write
```

### migration v22

```text
shadow_runs
```

只存：

```text
subsystem
canonical version
shadow version
匿名化 input fingerprint
canonical decision
shadow decision
diff
duration
```

不存完整私人 prompt。

---

# 十、Experiment / A-B

SOOYA 是单用户系统，传统 50/50 用户实验没有意义。

使用：

```text
shadow-first
day sticky
session sticky
conversation-window sticky
```

同一个 scope 内不能来回切 variant。

### migration v23

```text
experiments
experiment_assignments
experiment_events
```

状态：

```text
draft
shadow
running
paused
completed
cancelled
```

### API

```http
GET/POST/PATCH /api/admin/experiments
POST /api/admin/experiments/:id/start-shadow
POST /api/admin/experiments/:id/start
POST /api/admin/experiments/:id/pause
POST /api/admin/experiments/:id/complete
GET /api/admin/shadow-runs
```

正式实验默认必须先经过 shadow。

## 第一批实验

推荐只实验低风险策略：

```text
Life anti-repeat window
Continuity weight
Voice complement similarity threshold
Proactive share threshold
```

不要第一批实验核心回复模型。

## 指标

看：

```text
error
cancel
fallback
latency
user response
repeat
naturalness rejection
```

“用户回复率”只能算行为信号，不等于喜欢。

---

# 十一、Migration 顺序

从当前 v18 开始：

```text
v19 life_locations
v20 weather_snapshots
v21 metric_daily
v22 shadow_runs
v23 experiments
```

每个 migration 都必须加入：

```text
真实旧 DB fixture → latest
```

的升级测试。

---

# 十二、推荐开发顺序

## P0 World Foundation

1. Location schema/repo/service
2. WorldContextService
3. Location → Life Selector
4. Weather provider/cache
5. Weather → Life Selector
6. WorldContext → ContextBuilder/Proactive

## P1 Control UI

7. Life Admin API
8. Life Admin UI
9. Voice capability/settings API
10. Voice Preferences UI + preview

## P2 Observability

11. MetricsService
12. daily aggregation
13. Metrics Dashboard

## P3 Safe Experimentation

14. Shadow runtime
15. Shadow comparison UI
16. Experiment framework
17. Experiment UI

顺序原则：

```text
先有世界
→ 再能管理
→ 再能测量
→ 最后实验
```

---

# 十三、推荐 Commit 顺序

```text
1  feat(location): add life location model and visit state
2  feat(location): integrate location selection with Life V2
3  test(location): cover transitions repeat and restart

4  feat(weather): add provider abstraction cache and snapshots
5  feat(weather): feed weather into life scoring and world context
6  test(weather): cover stale fallback and activity effects

7  feat(admin): add life management APIs
8  feat(web): add Life Admin console
9  test(admin): cover mutation audit and lifecycle

10 feat(voice): expose provider capabilities and preview
11 feat(web): add Voice Preferences UI
12 test(voice): cover preferences quiet hours and preview

13 feat(metrics): add privacy-safe aggregation
14 feat(web): add metrics dashboard
15 test(metrics): verify aggregation and redaction

16 feat(shadow): add read-only shadow runtime
17 feat(web): add shadow comparison view
18 test(shadow): prove zero side effects

19 feat(experiments): add single-user experiment framework
20 feat(web): add experiment control panel
21 test(experiments): cover sticky assignment and attribution

22 test(e2e): cover world/admin/voice/shadow/experiment flows
23 docs: add delivery and rollout guide
```

---

# 十四、关键测试

## Location

- transition
- travel
- anti-repeat
- deleted location fallback
- restart
- timezone

## Weather

- cache
- stale fallback
- timeout
- unknown
- selector modifier
- location change refresh
- event dedupe

## Admin

- auth
- validation
- audit
- lifecycle mutation
- historical data protection

## Voice Preferences

- save/load
- capability mapping
- quiet hours
- explicit override
- preview isolation
- rate limiting

## Metrics

- aggregation accuracy
- privacy redaction
- retention

## Shadow

- zero side effect
- canonical unaffected
- failure isolation
- timeout isolation

## Experiment

- sticky assignment
- pause/resume
- shadow prerequisite
- metric attribution
- no mid-turn switching

---

# 十五、E2E 验收

1. plan 去咖啡店 → location transition；
2. 下雨 → outdoor 权重下降；
3. Weather provider 挂掉 → Life/Chat 正常；
4. World context 不虚构地址；
5. Admin 创建 location → Life 后续可选；
6. Admin 创建 plan → 后续执行；
7. Admin resolve thread → 不再推进；
8. Voice setting 下一条语音真实生效；
9. quiet hours 阻止自动语音，明确请求仍发送；
10. preview 不产生聊天记录；
11. Shadow 开启后 canonical 行为不变；
12. shadow failure 不影响主流程；
13. experiment day assignment 当天 sticky；
14. pause experiment 立即回 control；
15. dashboard 数据和底层 audit 对得上；
16. dashboard 无私人正文。

---

# 十六、灰度顺序

## Phase 1

```text
Location ON
Weather OFF
Life Admin ON
```

## Phase 2

```text
Weather ON
```

天气只影响评分，不主动报天气。

## Phase 3

```text
Voice Preferences ON
Metrics ON
Dashboard ON
```

## Phase 4

```text
Shadow ON
```

只 shadow planner/selector。

## Phase 5

```text
Experiments ON
```

先实验 anti-repeat / continuity。

---

# 十七、回滚

所有模块必须支持：

```text
flag OFF
```

快速回退。

- 新表保留，不要求降 migration。
- Weather/Location 关闭后 Life 回当前稳定行为。
- Shadow/Experiment 关闭后 canonical 完全不变。
- UI flag 关闭不影响 API/核心运行。
- provider 故障必须 graceful degradation。

---

# 十八、隐私与性能

## Location

- 默认 SOOYA 自己的位置；
- 不自动读取用户 GPS；
- 精确坐标 optional。

## Weather

- 只发送必要 location key；
- 不每条消息请求天气。

## Metrics/Shadow

- 不存完整聊天正文；
- 不存完整私人 prompt；
- 不存不必要的精确地址。

## 性能

- Location selector 本地计算；
- Weather 使用缓存；
- Metrics 后台聚合；
- Shadow 不阻塞 canonical；
- 模型 Shadow 必须独立 budget 和 timeout。

---

# 十九、完成标准

只有全部满足才算下一阶段完成：

```text
Location 生命周期闭环
Weather 缓存与故障降级完成
WorldContext 真正影响 Life
Life Admin 可完整管理
Voice Preferences 可完整设置
Metrics 可观测且隐私安全
Shadow 零副作用
Experiment sticky 且可暂停
```

门禁：

```text
typecheck PASS
server tests PASS
web tests PASS
build PASS
E2E PASS
migration fixture PASS
restart recovery PASS
GitHub CI PASS
```

完成后的生活链：

```text
Theme
↓
Vitals
↓
时间
↓
Location
↓
Weather
↓
Plan / Thread
↓
Activity
↓
Travel / Outcome / Event
↓
状态变化
↓
Proactive Candidate
↓
ReplyCoordinator
↓
自然文字 / 语音 / 图片
```

开发链：

```text
新策略
↓
Shadow
↓
Metrics
↓
Experiment
↓
灰度
↓
正式上线
```

这就是下一阶段的完整目标：让 SOOYA 不只是“有连续生活”，而是有一个真正可管理、可观察、可安全迭代的生活世界。
