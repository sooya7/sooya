# SOOYA 下一阶段 — 共享 Contract（Phase 0 Freeze）

> 冻结时间：2026-08-08
> 依据：《SOOYA-下一阶段一次性完整收口与交付方案.md》§2/§4/§5/§6/§10/§11/§12/§13
> 规则：Phase 1 开始后，除 Integration Agent 外，任何实现代理不得修改本文件的类型与 API 契约。如必须修改：提交 integration note，由 Integration Agent 统一评估。

---

## 1. 冻结类型

### 1.1 Location

```ts
// 现状（location.repo.ts，冻结）
type LocationKind =
  | 'home' | 'neighborhood' | 'cafe' | 'restaurant'
  | 'store' | 'park' | 'library' | 'mall'
  | 'transit' | 'work' | 'study' | 'venue'
  | 'outdoor' | 'other';
type LocationSource = 'builtin' | 'generated' | 'admin' | 'conversation';
type TravelMode = 'walk' | 'bike' | 'transit' | 'car' | 'unknown';

// 新增（本轮，Agent A 定义、Integration 对齐）
interface LifeCity {
  id: string;
  name: string;
  region?: string;
  country?: string;
  timeZone: string;   // IANA；唯一 active 城市上下文
  active: boolean;
}

// LifeLocation 扩展字段（Agent A 实现，类型定义归 Agent A）
//   cityId?: string | null
//   timeZone?: string | null          // IANA；缺省回退 LIFE_TIME_ZONE
//   lat/lng 为可选的 coarse/exact 坐标

interface TravelState {
  fromLocationId: string;
  toLocationId: string;
  mode: TravelMode;
  startedAt: string;
  expectedArriveAt: string;   // 禁止瞬移；到达后写 state + visit
}
```

### 1.2 Weather

```ts
// 现状（weather.repo.ts，冻结）
interface WeatherSnapshot {
  observedAt: string;
  condition: WeatherCondition;
  temperatureC?: number;
  feelsLikeC?: number;
  humidity?: number;
  precipitationMm?: number;
  windKph?: number;
  provider: string;
  locationKey: string;
  stale: boolean;
}

// 现状（weather/service.ts，冻结）
interface WeatherLocation {
  key: string;
  city?: string | null;
  region?: string | null;
  lat?: number | null;
  lng?: number | null;
}
interface WeatherProvider {
  name: string;
  configured: boolean;
  current(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherSnapshot>;
}

// 新增（本轮，Agent B 定义）
interface WeatherForecastPeriod {
  at: string;                 // ISO
  condition: WeatherCondition;
  temperatureC?: number;
  precipitationMm?: number;
  windKph?: number;
}
interface WeatherForecast {
  locationKey: string;
  generatedAt: string;
  provider: string;
  periods: WeatherForecastPeriod[];   // 未来 12h（逐小时）+ 3 天（每日摘要）
}
interface WeatherForecastSummary {
  generatedAt: string;
  provider: string;
  next12h: WeatherForecastPeriod[];
  next3d: WeatherForecastPeriod[];
  severe: boolean;            // storm/heavy_rain/extreme_heat/extreme_cold/snow/strong_wind
}
interface DaylightSnapshot {
  sunrise: string;            // ISO（本地时区计算）
  sunset: string;
  isDaylight: boolean;
}
// FallbackWeatherProvider：primary → secondary → cache → unknown
// 语义事件（episode 去重，Agent B 固定类型名）：
//   weather.started_raining / weather.rain_stopped / weather.first_snow /
//   weather.storm / weather.heat_wave / weather.cold_snap
```

### 1.3 WorldContext

```ts
// 现状字段保留：now / timeZone / location / previousLocation / weather / weatherCondition
// 新增字段（Agent B 定义、Integration 对齐）：
interface WorldSnapshot {
  now: string;
  localDate: string;          // LIFE_TIME_ZONE 本地日期 YYYY-MM-DD
  timeZone: string;
  city?: LifeCity | null;
  location?: LifeLocation | null;
  previousLocation?: LifeLocation | null;
  travel?: TravelState | null;
  weather?: WeatherSnapshot | null;
  forecast?: WeatherForecastSummary | null;
  daylight?: DaylightSnapshot | null;
  weatherCondition?: WeatherCondition | null;   // 同步评分路径
}
```

### 1.4 Metrics

```ts
// 现状（metrics.repo.ts，冻结）：MetricDailyRow / MetricAggregate
// 新增（Agent C 定义）：
interface MetricsDistribution {
  category: string;
  metric: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}
interface ReleaseMetricsComparison {
  current: { from: string; to: string; aggregates: MetricAggregate[] };
  previous: { from: string; to: string; aggregates: MetricAggregate[] };
}
// 归档键：LIFE_TIME_ZONE 本地日期（禁止 UTC 切日）
// 导出：CSV / JSON，只含指标不含私人正文
```

### 1.5 Shadow / Experiments

```ts
// 现状（shadow.repo.ts，冻结）：ShadowRunRow / ExperimentStatus / AssignmentScope /
//   ExperimentRow / ExperimentAssignmentRow / ExperimentEventRow
// 新增（Agent C 定义）：
//   canonicalVariantForSubsystem(subsystem)     —— status=shadow 时永远 'control'
//   shadowVariantForSubsystem(subsystem)        —— shadow 采样用的变体
//   ExperimentRow 扩展：rolloutPercent（10/25/50/100）、deterministic sticky bucket
interface ExperimentReport {
  experimentId: string;
  name: string;
  samples: number;
  control: number;
  treatment: number;
  observedDifference: { metric: string; control: number; treatment: number }[];
  // 只写 observed difference，禁止伪造统计显著性
}
interface ExperimentHistoryEntry {
  id: string;
  experimentId: string;
  event: 'created' | 'shadow' | 'promoted' | 'paused' | 'resumed' | 'completed' | 'config_changed';
  variant: string;
  createdAt: string;
}
```

### 1.6 Visible Thoughts / Decision Trace

```ts
// 新增（Agent D 定义）：
type VisibleThoughtKind = 'inner_monologue' | 'decision_summary';
type VisibleThoughtVisibility = 'user' | 'admin';
type VisibleThoughtStatus = 'generating' | 'completed' | 'cancelled' | 'failed';

interface VisibleThought {
  id: string;
  messageId: string;
  batchId: string;
  revision: number;
  kind: VisibleThoughtKind;
  text: string;
  visibility: VisibleThoughtVisibility;
  status: VisibleThoughtStatus;
  createdAt: string;
}

interface DecisionTrace {
  batchId: string;
  revision: number;
  replyIntent?: string;          // 如 emotional_support
  lifeContext?: string[];        // 安全摘要，如 ['location: cafe']
  weather?: string | null;
  memoryRecallCount?: number;
  voiceMode?: string | null;
  semanticGuard?: 'pass' | 'reject' | 'fallback';
  experimentVariant?: string | null;
  proactive?: string | null;
  createdAt: string;
}

// ThoughtPresenter.prepare 输入白名单（禁止：system prompt 全文 / 隐藏 CoT /
//   内部安全规则 / API key / provider secrets / 原始 memory 检索全文 / 原始工具结果）
// ThoughtSafetyFilter：命中风险 → drop thought，绝不阻塞正常回复
// Revision fencing：AbortSignal + revision fence + publish barrier，旧 thought 必须 cancel
```

## 2. 冻结 API

```http
# Admin（现有 + 本轮扩展，全部 requireAdminToken）
GET    /api/admin/life/cities
POST   /api/admin/life/cities
PATCH  /api/admin/life/cities/:id
GET    /api/admin/life/locations
POST   /api/admin/life/locations
PATCH  /api/admin/life/locations/:id
DELETE /api/admin/life/locations/:id
GET    /api/admin/life/travel
POST   /api/admin/life/location/override
POST   /api/admin/life/geocode/search
GET    /api/admin/weather/status
GET    /api/admin/weather/forecast
POST   /api/admin/weather/refresh
GET    /api/admin/metrics
GET    /api/admin/metrics/distributions
GET    /api/admin/metrics/release-compare
GET    /api/admin/metrics/export?format=csv|json
GET    /api/admin/shadow-runs
GET    /api/admin/experiments
POST   /api/admin/experiments
PATCH  /api/admin/experiments/:id
GET    /api/admin/experiments/:id/report
GET    /api/admin/experiments/:id/history
GET    /api/admin/decision-trace?batchId=&revision=
GET    /api/admin/decision-trace/recent

# Settings / Voice（现有）
GET    /api/settings/voice/capabilities
POST   /api/settings/voice/preview

# Chat（现有 + 本轮）
GET    /api/bootstrap
POST   /api/stream
GET    /api/thoughts/:messageId        # user-visible inner thought（若该消息存在）
```

## 3. Feature Flags（冻结，Integration 统一接线，全部默认 OFF）

```env
WORLD_CONTEXT_ENABLED=false
LOCATION_MODEL_ENABLED=false
WEATHER_ENABLED=false
LIFE_ADMIN_UI_ENABLED=false
VOICE_PREFERENCES_UI_ENABLED=false
METRICS_DASHBOARD_ENABLED=false
SHADOW_MODE_ENABLED=false
EXPERIMENTS_ENABLED=false
VISIBLE_THOUGHTS_ENABLED=false
VISIBLE_INNER_MONOLOGUE_ENABLED=false
ADMIN_DECISION_TRACE_ENABLED=false
```

## 4. Migration 编号（Integration 统一分配，实现代理不得抢版本）

```text
v24 visible_thoughts
v25 life_cities + city_id + travel_state
v26 metrics_distribution + release metadata
v27 experiment rollout/history 字段
v28 weather_forecasts（如需持久化）
```

> 实现代理在自己的 worktree 中可临时追加本地 migration 以便测试（编号段自定），但必须在 INTEGRATION-NOTES 中给出最终 DDL；最终版本号由 Integration 统一重写。

## 5. 公共文件所有权（Integration 独占）

```text
packages/server/src/app.ts
packages/server/src/config/env.ts
packages/server/src/db/migrations.ts
packages/web/src/AppShell.tsx
.env.example
docs/NEXT-PHASE-DELIVERY.md
docs/NEXT-PHASE-UPGRADE-PLAN.md
```

## 6. 代理交付物模板（SUMMARY / FILES_CHANGED / TESTS / PUBLIC_API / MIGRATION_NEEDS / ENV_NEEDS / INTEGRATION_STEPS / KNOWN_RISKS）
