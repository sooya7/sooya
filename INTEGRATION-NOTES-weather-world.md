# INTEGRATION-NOTES — Agent B：Weather 完整版 + WorldContext 完整版

Worktree: `.worktrees/sooya-weather`（branch `agent/weather-world`）
契约依据：`docs/NEXT-PHASE-CONTRACTS.md` §1.2 / §1.3 / §2 / §4 / §5
状态：功能与测试完成（36/36 PASS），**未宣称 READY TO MERGE**；以下为 Integration 收口所需全部信息。

## SUMMARY

按方案 §5/§6/§7 将 Weather/WorldContext 做成完整版：

1. **真实生产 Provider + Fallback chain**（`core/weather/provider.ts` + `fallback.ts`）：
   - `createWeatherProvider(env)` 工厂：`WEATHER_PROVIDER=open-meteo` → `OpenMeteoWeatherProvider`（免费无 key，WMO code 映射 + current/hourly/daily/sunrise-sunset 三合一适配）；未配置/未知名称 → `configured=false` 的 no-op，绝不伪装成功。
   - `FallbackWeatherProvider`：`primary → secondary → cached snapshot → unknown`；forecast 同理 `→ cached forecast → null`；daylight `→ null`（服务层再补缓存/天文）。降级腿打 `degraded: true`，服务层不落库、不触发语义事件。
   - `createWeatherChain(env, cache?)` 便捷工厂：`WEATHER_PROVIDER='a,b'` 组装主备。
2. **Current Weather 完整字段**：`WeatherSnapshot` 在冻结字段上**只增** `visibilityKm` / `pressureHpa` / `degraded`（degraded 为降级腿标记，只读不落库）。
3. **Forecast**（`forecast.ts`）：`WeatherForecastPeriod`（新增可选 `periodKind: 'hourly'|'daily'`，用于 12h/3d 拆分）/ `WeatherForecast` / `WeatherForecastSummary`（next12h + next3d + severe）按 contract §1.2；`WeatherService.forecastFor` 30 分钟缓存 + 失败回退缓存摘要。
4. **Severe weather**（`severe.ts`）：storm / heavy_rain(≥10mm/h) / extreme_heat(≥35℃) / extreme_cold(≤-10℃) / snow / strong_wind(≥60kph) 六类；只进评分/事件，不制造情绪。`severeWithinHours(summary, iso, hours)` 供活动评分同步判断。
5. **Sunrise/Sunset/Daylight**（`daylight.ts`）：provider 返回优先 → NOAA 天文算法估算（±2 分钟，已用上海 2026-08-08 实测 05:15/18:44）→ 无数据返回 null；`isDaylight` 永远即时计算。按 `LIFE_TIME_ZONE`/location.timeZone 本地时区；无 tz 时回退 UTC 日期（见 KNOWN_RISKS）。
6. **WorldContext 完整版**（`world-context.ts`）：`WorldSnapshot` 实现 contract §1.3 全部字段（now/localDate/timeZone/city/location/previousLocation/travel/weather/forecast/daylight/weatherCondition）。`previousLocation` **真实来自持久化**：从 `life_location_visits` 取最近一条 location_id ≠ 当前的位置（无需改 location 模块）。`city`/`travel` 为占位 null（Agent A v25 落地后接入，类型以 `import type` 占位写在 world-context.ts 内，见 INTEGRATION_STEPS）。
7. **WorldContext × Life 融合**（`life2/activities.ts` + `engine.ts`）：`ScoreContext` 新增可选 `forecast` / `daylight`；修饰规则（仍是多因素评分一部分，非硬规则）：未来 2 小时内 severe → 长时间户外（≥20min）减 20；日落后 17-22 点 walk 加 10。engine `bestScored` 同步组装 `cachedForecastSummary` + `cachedDaylight`（绝不触发网络）；engine ctor 签名**未变**（仍接收可选 `weather?: WeatherService`）。
8. **语义事件**：类型名按 contract 固定：`weather.started_raining` / `weather.rain_stopped` / `weather.first_snow` / `weather.storm` / `weather.heat_wave` / `weather.cold_snap`；全部按 episode 去重；**修复 typo**：旧代码 storm 事件实际发出 `weather.weather.storm`；新增 `rain_stopped`（雨停）、`heat_wave`/`cold_snap`（温度阈值，episode 去重）。
9. **真实性与降级**：WorldContext 全部来自持久化/provider；provider 全失败 → cache → unknown，`weather-forecast.test.ts` 有专门用例证明 provider 全挂时 chat 仍 200、不产生任何语义事件。

## FILES_CHANGED

新增：
- `packages/server/src/core/weather/provider.ts`（`WeatherProviderFull` / `createWeatherProvider` / `OpenMeteoWeatherProvider` / `weatherLocationKey` / `wmoCondition`）
- `packages/server/src/core/weather/fallback.ts`（`WeatherCacheReader` / `FallbackWeatherProvider` / `createWeatherChain`）
- `packages/server/src/core/weather/forecast.ts`（contract §1.2 类型 + `summarizeForecast` / `forecastFromRow` / `forecastSummaryFromRow` / `severeWithinHours`）
- `packages/server/src/core/weather/severe.ts`（`SevereWeatherKind` / `severeWeatherKinds` / `severeLabel`）
- `packages/server/src/core/weather/daylight.ts`（`computeIsDaylight` / `astronomyDaylight`）
- `packages/server/test/weather-forecast.test.ts`（22 用例）
- `packages/server/test/world-context.test.ts`（8 用例）

修改：
- `packages/server/src/db/repos/weather.repo.ts`（快照新列 + `WeatherForecastRow`/`WeatherDaylightRow` + `latestForecast`/`saveForecast`/`daylightFor`/`saveDaylight`）
- `packages/server/src/core/weather/service.ts`（全字段快照、forecast/daylight API、语义事件重写、`setProvider` 接受 `WeatherProviderFull`）
- `packages/server/src/core/world-context.ts`（WorldSnapshot §1.3 + `refreshAll` + 可选 `locationsRepo` 构造参数 + LifeCity/TravelState 占位类型）
- `packages/server/src/core/life2/activities.ts`（ScoreContext 可选 `forecast`/`daylight` + 修饰逻辑）
- `packages/server/src/core/life2/engine.ts`（`bestScored` 组装 forecast/daylight 输入 + shadow input 增加 `forecastSevere`/`daylightKnown`；ctor 签名不变）
- `packages/server/src/util/time-zone.ts`（**修复既有 bug**，见 KNOWN_RISKS）
- `packages/server/src/db/migrations.ts`（**临时** version 902 `tmp_weather_full`，最终 DDL 见 MIGRATION_NEEDS）

未触碰（按约束）：`app.ts`、`config/env.ts`、`AppShell.tsx`、`.env.example`、`docs/*`、location 模块、metrics/shadow/experiments/thoughts/voice/reply 模块。

## TESTS

命令（packages/server 下）：
`npx vitest run test/weather.test.ts test/weather-forecast.test.ts test/world-context.test.ts`

结果：**36/36 PASS**（`npm run typecheck` 0 error）

| 文件 | 用例数 | 覆盖（方案 QA 矩阵） |
| --- | --- | --- |
| weather.test.ts（更新保留） | 6 | 既有回归：flags 关闭惰性 / 缓存新鲜度 / provider 失败→stale / 无缓存→unknown / 雨事件去重 / rain 抑制户外评分 |
| weather-forecast.test.ts | 22 | 工厂 no-op（未配置→configured=false）；open-meteo current 全字段（含 visibility/pressure/本地时间换算）；forecast 12h+3d 与 severe 判定；daylight 本地日出日落；**primary 成功 / primary 失败→secondary / 全失败→cache / 无 cache→unknown**；forecastFor 30 分钟缓存+故障回退；daylightFor 缓存+天文估算（上海 05:15±20min）；**forecast 暴雨→户外活动分降低**；无 severe 不影响评分；**sunset 后 daylight 修饰**（+10）；**语义事件 episode 去重**（storm typo 修复 `weather.storm`、rain_stopped、heat_wave/cold_snap、unknown 降级零事件）；**provider 故障不影响 chat（200 + unknown）** |
| world-context.test.ts | 8 | flags 全关缺省空态；refreshAll 全字段（localDate/timeZone/weather/forecast/daylight/location）；同步快照只读缓存（零 provider 调用）；**previousLocation 来自真实 visit 记录**；provider 全挂 refreshAll 不抛错；stale 标记真实；cachedCondition/cachedSnapshot 一致；字段集合与 §1.3 一致 |

额外回归（改动共享 util 后验证）：`life-engine / life-plans / life-panel / location / context-batch-life` 5 文件 38/38 PASS。

已知（预期）失败：`migration-rollback.test.ts` 首个用例断言版本 1..LATEST_VERSION 连续，临时 902 会使其失败——Integration 统一编号后恢复（见 MIGRATION_NEEDS / KNOWN_RISKS）。迁移本身干净可应用。

## PUBLIC_API

新增导出（`packages/server/src/core/weather/*`、`world-context.ts`、`life2/activities.ts`）：

```ts
// provider.ts
interface WeatherProviderFull extends WeatherProvider {   // WeatherProvider 冻结不变
  forecast?(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherForecast | null>;
  daylight?(location: WeatherLocation, signal?: AbortSignal): Promise<DaylightSnapshot | null>;
}
interface WeatherProviderEnv { provider?; baseUrl?; apiKey?; timeoutMs?; fetchImpl?; clock? }
function createWeatherProvider(env?: WeatherProviderEnv): WeatherProviderFull;
function weatherLocationKey(location: WeatherLocation): string;
function wmoCondition(code: number | null | undefined): WeatherCondition;
class OpenMeteoWeatherProvider implements WeatherProviderFull { name='open-meteo'; configured=true }

// fallback.ts
interface WeatherCacheReader { latest(key): WeatherSnapshotRow | undefined; latestForecast(key): WeatherForecastRow | undefined }
class FallbackWeatherProvider implements WeatherProviderFull { name='fallback'; configured: boolean }
function createWeatherChain(env?: WeatherProviderEnv, cache?: WeatherCacheReader | null): WeatherProviderFull;

// forecast.ts（contract §1.2）
interface WeatherForecastPeriod { at; condition; temperatureC?; precipitationMm?; windKph?; periodKind?: 'hourly'|'daily' }
interface WeatherForecast { locationKey; generatedAt; provider; periods }
interface WeatherForecastSummary { generatedAt; provider; next12h; next3d; severe }
interface DaylightSnapshot { sunrise; sunset; isDaylight }
function summarizeForecast(...): WeatherForecastSummary; function severeWithinHours(summary, atIso, hours): boolean;

// severe.ts
type SevereWeatherKind = 'storm'|'heavy_rain'|'extreme_heat'|'extreme_cold'|'snow'|'strong_wind';
function severeWeatherKinds(condition, temperatureC?, windKph?, precipitationMm?): SevereWeatherKind[];

// daylight.ts
function computeIsDaylight(sunriseIso, sunsetIso, atIso): boolean;
function astronomyDaylight(lat, lng, at, timeZone?, localDate?): DaylightSnapshot | null;

// service.ts（现有 API 全部保留；setProvider 参数放宽为 WeatherProviderFull | null）
cachedSnapshot(location): WeatherSnapshot | null;                        // 同步
forecastFor(location, signal?): Promise<WeatherForecastSummary | null>;
cachedForecastSummary(location): WeatherForecastSummary | null;          // 同步
daylightFor(location, at?, timeZone?, signal?): Promise<DaylightSnapshot | null>;
cachedDaylight(location, at?, timeZone?): DaylightSnapshot | null;       // 同步

// world-context.ts（WorldSnapshot 全字段见 contract §1.3；新增）
new WorldContextService(location, weather, clock?, defaultTimeZone?, locationsRepo?: LifeLocationRepo | null)
refreshAll(): Promise<WorldSnapshot>;   // current+forecast+daylight 全量刷新，各步失败被吞

// life2/activities.ts（ScoreContext 新增可选字段）
forecast?: WeatherForecastSummary | null;
daylight?: DaylightSnapshot | null;
```

## MIGRATION_NEEDS

Integration 统一编号（建议 `v28 weather_forecasts + weather_snapshots 扩展列`，或拆 v29 `weather_daylight`）。请删除临时 902 并替换为（幂等 DDL，目标库可能是已应用 v20-23 的旧库）：

```sql
-- weather_snapshots 增加列（现有表 ALTER）
ALTER TABLE weather_snapshots ADD COLUMN visibility_km REAL;
ALTER TABLE weather_snapshots ADD COLUMN pressure_hpa REAL;

-- forecast 持久化
CREATE TABLE weather_forecasts (
  location_key TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  provider     TEXT NOT NULL,
  periods_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (location_key, generated_at)
);
CREATE INDEX idx_weather_forecasts_key ON weather_forecasts(location_key, generated_at DESC);

-- daylight 持久化（按本地日期一行）
CREATE TABLE weather_daylight (
  location_key TEXT NOT NULL,
  local_date   TEXT NOT NULL,
  sunrise      TEXT NOT NULL,
  sunset       TEXT NOT NULL,
  provider     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (location_key, local_date)
);
```

## ENV_NEEDS

```env
WEATHER_PROVIDER=open-meteo          # 当前可用适配器；'a,b' 表示主备链（见 createWeatherChain）
WEATHER_BASE_URL=https://api.open-meteo.com   # 可选，适配器 API 根地址
WEATHER_API_KEY=                     # open-meteo 不需要；留给需要 key 的 provider
WEATHER_TIMEOUT_MS=5000              # 单次 provider 请求超时
```

以上 env **只写入本 notes**；请 Integration 加入 `config/env.ts`（含 z.string().default 等）与 `.env.example`。Feature flag 沿用冻结的 `WORLD_CONTEXT_ENABLED` / `WEATHER_ENABLED`（默认 OFF，无需新增）。

## INTEGRATION_STEPS

1. **app.ts 接线（Integration 独占）**：
   - `const weatherChain = createWeatherChain({ provider: env.WEATHER_PROVIDER, baseUrl: env.WEATHER_BASE_URL, apiKey: env.WEATHER_API_KEY, timeoutMs: env.WEATHER_TIMEOUT_MS }, repos.weather);`
   - `weather.setProvider(weatherChain);`（在现有 `setEnabled` 之后；provider 未配置时工厂返回 no-op，`setProvider` 自动视为 null → 行为与现状完全一致）
   - `new WorldContextService(location, weather, opts.clock, env.LIFE_TIME_ZONE, repos.locations)` —— **第 5 个可选参数**传 `repos.locations`，previousLocation 才会工作（不传则恒为 null，行为不崩）。
   - `world.refreshAll()` 建议挂到现有定时/维护节拍或 admin 刷新路由（失败被吞，不影响任何路径）。
2. **Life 评分输入**：engine `bestScored` 已直接读 `cachedForecastSummary` / `cachedDaylight`（同步、缓存/天文、零网络）——**无需改 app.ts/engine ctor**。Weather 未启用时两输入为 null，评分与基线逐位一致（现有 life 测试 38/38 证明）。
3. **路由清单（Integration 实现，均 requireAdminToken）**：
   - `GET /api/admin/weather/status` → `world.snapshot()`（weather/forecast/daylight/weatherCondition）
   - `GET /api/admin/weather/forecast` → `weather.forecastFor(weatherLocation)`（或 world.snapshot().forecast）
   - `POST /api/admin/weather/refresh` → `world.refreshAll()`
4. **Agent A 合并后**（location 模块 v25）：
   - 删除 `world-context.ts` 顶部的 `LifeCity` / `TravelState` 占位接口（文件内有 PLACEHOLDER 注释标记），替换为 `import type { LifeCity, TravelState } from '../db/repos/location.repo.js'`；
   - `snapshot()` 中 `city` / `travel` 两处 `null` 占位改为真实读取（life_cities active 城市 + travel_state）；
   - `previousLocation` 可选改读 state 的 previous_location_id（当前实现读 visits，语义等价、零改动可用）。
5. **migrations**：删除临时 902，替换为 MIGRATION_NEEDS 的正式 DDL（v28+）；恢复 `migration-rollback.test.ts` 的 1..N 连续版本断言。
6. **util/time-zone.ts 修复**（已提交 d541761）：`localDateTimeToUtc` IANA 分支改为固定点迭代（旧实现第二轮重复减偏移，IANA 时区结果整体偏一个偏移量，生产 `LIFE_TIME_ZONE=Asia/Shanghai` 下 plan 生成受影响；本修复让其正确）。**修复已被本分支测试验证**（38 个相邻 life/location 测试通过），建议 Integration 在全量回归中再确认一次。
7. **语义事件**：`LifeRepo.recordEvent` 现用法不变；事件类型固定为 contract §1.2 六种（`weather.storm` 已修 typo）。

## KNOWN_RISKS

1. **临时 migration 902 破坏 `migration-rollback.test.ts` 连续性断言**（唯一预期失败）。迁移本身可干净应用；Integration 重编号后该测试自动恢复。**不得带着 902 合入主干。**
2. **`util/time-zone.ts` 为共享文件**：修复改变了 IANA 分支返回值（从错误变正确）。本分支跑了 5 个相邻测试文件 38/38 通过；但未跑全量套件，Integration 全量回归时应特别关注任何依赖旧错误值的用例（理论不存在——旧值即错值）。
3. **daylight 缓存键的时区缺省**：`daylightFor/cachedDaylight` 未传 timeZone 时按 UTC 日期取缓存键，上海 0-8 点本地会多取一次（功能不受损，仅多一次请求）；真实接线（world 传 `LIFE_TIME_ZONE`、engine 传 `settings.timeZone`）均带 tz，无影响。
4. **previousLocation 为启发式**：基于 `life_location_visits`（最近一条不同 location_id 的 visit）。若 Agent A 落地 `previous_location_id`，可无缝切换；两法都不编造。
5. **`city`/`travel` 为占位 null**：Agent A v25 前快照如实缺省；本分支测试断言 null，合并后由 Integration 更新断言。
6. **open-meteo 需要 lat/lng**：无坐标的 location 会走 secondary/cache/unknown 降级（链测试覆盖）；管理端应为内置地点补坐标。
7. **降级快照不落库**（degraded 设计）：provider 故障期间快照历史出现空隙，避免假新鲜记录；这是有意的语义，上下文行/聊天只读 cache 或 unknown。
8. **forecast 摘要拆分依赖 `periodKind`**：新增可选字段；老数据（无 periodKind）回退时间启发式（12h 切点），不会崩。
9. **天文算法误差 ±2 分钟**（NOAA 近似），仅作 provider 缺失时的优雅缺省；provider 数据优先。
