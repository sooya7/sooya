# INTEGRATION-NOTES-location（Agent A：Location Model 完整实现）

> 分支：`agent/location-complete`，基线 `6fbf768`。
> 契约依据：`docs/NEXT-PHASE-CONTRACTS.md` §1.1 / §2 / §4 / §5。

## SUMMARY

把 Location Model 从 v19 基础版做成完整版，全部行为仍由 `WORLD_CONTEXT_ENABLED && LOCATION_MODEL_ENABLED` 门控（开关关闭时服务完全惰性，行为与稳定版一致）。

1. **内置 Edge 修复**：种子改用稳定 key（新增 `life_locations.key` 唯一列，`{ key: 'home', name: '家' }`），彻底移除"显示名称当内部 key"的旧逻辑（旧代码 byName 用中文名做 key 但边表引用英文名，导致默认出行边从未真正建库）。现在 `BUILTIN_EDGES` 按 key 双向建边（步行时间对称），测试断言 `edge(home, cafe)` 真实存在（15 分钟 walk）。
2. **时区统一**：新增 `core/location/tz.ts`（`localDateAt` / `localHourAt` / `localTimeParts` / `utcOffsetMinutesAt` / `isValidTimeZone`，全部走 Intl），删除 `getUTCHours() + 8`。时区通过构造注入（`LocationServiceOptions.timeZone`，默认 `Asia/Shanghai`），**不读 env**。选择器小时 = `localHourAt(now, timeZoneFor(current))`。
3. **LifeCity 多城市**：`LifeCity { id, name, region?, country?, timeZone, active }`（契约冻结形状）+ `LifeCityRepo`（`db/repos/location.repo.ts`），`life_locations.city_id` 列；唯一 active 城市不变量（create/update/deactivate/setActiveCity 全链路保证恰好一个 active）。跨城旅行 = travel → 到达 → `switchCityIfNeeded` → active 城市切换 → 时区切换（`timeZoneFor` 三级回退：location.timeZone → city.timeZone → 注入默认）。
4. **Geocoding 抽象**：`core/location/geocoding.ts` 定义 `GeocodingProvider { search; reverse? }` + `NO_GEOCODER` 空实现，service 的 `geocodeSearch/geocodeReverse` 无 provider 优雅降级（返回空/ null，不抛错）；只接受管理端显式坐标，**不读用户 GPS**。
5. **TravelState 防瞬移**：`core/location/travel.ts` 定义契约形状 `TravelState { fromLocationId, toLocationId, mode, startedAt, expectedArriveAt }`（+ 内部溯源字段）。活动解析只触发"出发"（写 `travel_state`，关闭出发地 visit）；`expectedArriveAt` 到期后的**惰性结算**（`current()/currentState()/currentTravel()/contextLines()/下一次 onActivityResolved` 读取时）写 state + visit（以预计到达时刻为 canonical 抵达时间，带 plan/activity 溯源）并清空行程。Life 上下文可表达"正在步行去街角咖啡店的路上，预计15分钟后到"。无边兜底 `DEFAULT_TRAVEL_MINUTES = 15`（walk）。
6. **Thread location tags 闭环**：`threadLocationTags()` 现在通过 `setThreadsProvider()` 注入的真实 open threads（`life_threads` 行）取标签；选择器按命中数加分（首个 +10，每个额外 +4，封顶 30）。测试证明：同分候选在带标签时选择器必然改选匹配项（线程加成 10 > hash 噪音 ±4），且服务层 `scoreBreakdown.thread` 真实出现。
7. **重启安全**：city / travel / visits / state 全部落库，重启后不漂移；在途行程重启后用新时钟第一次读取即惰性结算（测试覆盖）。种子幂等：有 key 或存在历史数据（v19 升级库）不重复播种。

## FILES_CHANGED

```
packages/server/src/core/location/tz.ts          (新增) IANA 时区纯函数工具
packages/server/src/core/location/geocoding.ts   (新增) GeocodingProvider 抽象 + NO_GEOCODER
packages/server/src/core/location/travel.ts      (新增) TravelState 模型纯函数
packages/server/src/core/location/service.ts     (重写) LocationService 完整实现
packages/server/src/core/location/selector.ts    (修改) thread 命中加分 10+4/标签 封顶 30
packages/server/src/db/repos/location.repo.ts    (扩展) key/city_id 列、LifeCityRepo、travel_state CRUD、dbHandle getter、recentlyVisitedLocationIds(nowMs)
packages/server/src/db/migrations.ts             (临时) 追加 version 901 tmp_location_full（本地测试用，Integration 合并时删除）
packages/server/test/location.test.ts            (更新) 防瞬移语义 + 稳定 key/真实边/线程标签/时区工具/legacy 库
packages/server/test/location-city.test.ts       (新增) 城市模型
packages/server/test/location-travel.test.ts     (新增) 防瞬移/重启
INTEGRATION-NOTES-location.md                    (新增) 本文件
```

未改动任何禁止文件（app.ts / config/env.ts / AppShell.tsx / .env.example / docs/* / 其他模块）。

## TESTS

命令（packages/server 下）：`npx vitest run test/location.test.ts test/location-city.test.ts test/location-travel.test.ts`

- `location.test.ts`：12 项 —— 开关惰性、稳定 key + 真实边 + 家基线、活动解析→出发→到达（plan 溯源）、anti-repeat + 线程标签、线程标签服务层接线、线程标签翻盘（纯选择器）、重启不漂移、admin CRUD/override 审计、GET /api/life/locations、legacy 库不重复播种、tz.ts 工具函数。
- `location-city.test.ts`：6 项 —— 默认城市种子、唯一 active 不变量、唯一城市停用守卫、跨城旅行到达切城市切时区、timeZoneFor 三级回退、城市/ city_id 重启持久。
- `location-travel.test.ts`：6 项 —— 出发不瞬移 + 上下文"正在走去"、到期写 state+visit、已在目标不重复行程、override 取消行程、在途行程重启惰性结算、无边兜底 15 分钟。

**PASS：24 / 24**（连跑 3 轮无 flake）；`npm run typecheck` 0 error。

## PUBLIC_API

新增/变更的公共面（供 Integration / 其他代理使用）：

```ts
// core/location/tz.ts
export const DEFAULT_TIME_ZONE: string;                       // 'Asia/Shanghai'
export function localDateAt(at: Date, zone: string): string;  // YYYY-MM-DD
export function localHourAt(at: Date, zone: string): number;  // 0-23
export function localTimeParts(at: Date, zone: string): LocalTimeParts;
export function utcOffsetMinutesAt(at: Date, zone: string): number;
export function isValidTimeZone(zone: string): boolean;

// core/location/geocoding.ts
export interface GeocodingCandidate { name; lat?; lng?; city?; region?; country?; tags?; kind?; }
export interface GeocodingProvider {
  name: string;
  search(query: string, opts?: { signal?; limit? }): Promise<GeocodingCandidate[]>;
  reverse?(lat: number, lng: number, opts?: { signal? }): Promise<GeocodingCandidate | null>;
}
export const NO_GEOCODER: GeocodingProvider;
export function isGeocodingConfigured(provider): boolean;

// core/location/travel.ts
export interface TravelState { fromLocationId; toLocationId; mode; startedAt; expectedArriveAt;
  sourcePlanId?; sourceActivityId?; }          // 契约 6 字段 + 可选溯源
export const DEFAULT_TRAVEL_MINUTES = 15;
export function travelDueAt(travel, now): boolean;
export function travelRemainingMinutes(travel, now): number;
export const MODE_LABELS: Record<TravelMode, string>;

// db/repos/location.repo.ts
export interface LifeCity { id; name; region?; country?; timeZone; active; }   // 契约冻结形状
export class LifeCityRepo { list/get/getByKey/activeCity/create/update/deactivate/setActiveCity }
// LifeLocation 扩展（兼容原有字段）：key?, cityId?
// LifeLocationRepo 新增：getByKey / byCityId / dbHandle / currentTravel / setTravel / clearTravel
//   recentlyVisitedLocationIds(hours, nowMs?)

// core/location/service.ts（构造签名向后兼容，前 5 参不变）
export interface LocationServiceOptions { timeZone?; geocoding?; cityRepo?; }
// 新增方法：listCities / activeCity / createCity / updateCity / deactivateCity / setActiveCity /
//   timeZoneFor(location) / geocodeSearch(query, limit?) / geocodeReverse(lat, lng) /
//   currentTravel() / setThreadsProvider(fn) / geocodingConfigured / timeZoneDefault
// 变更语义：onActivityResolved 不再瞬移（出发），到达由惰性结算完成；
//   current() 在途时返回出发地；override 仍瞬移并清空在途行程。
```

## MIGRATION_NEEDS

Integration 统一编号 **v25**（替换本 worktree 临时 migration 901，删除 901）。最终 DDL：

```sql
CREATE TABLE life_cities (
  id         TEXT PRIMARY KEY,
  key        TEXT UNIQUE,
  name       TEXT NOT NULL,
  region     TEXT,
  country    TEXT,
  time_zone  TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_life_cities_active ON life_cities(active);

CREATE TABLE travel_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  from_location_id   TEXT NOT NULL REFERENCES life_locations(id) ON DELETE CASCADE,
  to_location_id     TEXT NOT NULL REFERENCES life_locations(id) ON DELETE CASCADE,
  mode               TEXT NOT NULL DEFAULT 'walk' CHECK (mode IN ('walk','bike','transit','car','unknown')),
  started_at         TEXT NOT NULL,
  expected_arrive_at TEXT NOT NULL,
  source_plan_id     TEXT,
  source_activity_id TEXT,
  created_at         TEXT NOT NULL
);

ALTER TABLE life_locations ADD COLUMN city_id TEXT REFERENCES life_cities(id) ON DELETE SET NULL;
ALTER TABLE life_locations ADD COLUMN key TEXT;
CREATE UNIQUE INDEX idx_life_locations_key ON life_locations(key) WHERE key IS NOT NULL;
```

注意：`life_locations.key` 与 `city_id` 是种子/多城市必需列，请并入 v25（契约 §4 的 v25 描述为 life_cities + city_id + travel_state，key 为其必要补充）。

## ENV_NEEDS

无新增 env。时区由构造注入（默认 `Asia/Shanghai`），**不读 env**（原有 `LIFE_TIME_ZONE` 保留给 WorldContextService 等既有使用方，二者默认值一致）。

## INTEGRATION_STEPS

1. **migrations.ts**：把 901 内容并入 v25（见上），删除 tmp 条目。旧库升级路径已验证（legacy 行不重复播种）。
2. **app.ts（LocationService 构造）**：现有 5 参调用点**无需改动**（`new LocationService(repos.locations, repos.audit, opts.clock, weatherConditionFor, shadow)` 保持兼容，新增第 6 参可选）。建议接线：
   ```ts
   const location = new LocationService(repos.locations, repos.audit, opts.clock, weatherConditionFor, shadow, {
     // timeZone: 'Asia/Shanghai',            // 可选，缺省 Asia/Shanghai
     // geocoding: <GeocodingProvider 实现>,  // 可选，缺省 NO_GEOCODER（优雅降级）
     // cityRepo: new LifeCityRepo(repos.locations.dbHandle) // 可选；缺省 service 自建
   });
   location.setThreadsProvider(() => repos.lifeV2.threads('open')); // 真实 open threads → 选择器
   ```
   `LifeCityRepo` 已能由 service 从 `repos.locations.dbHandle` 自建，app.ts 可不改构造也能获得完整城市能力；GeocodingProvider 若未接线则 search/reverse 优雅降级。
3. **路由注册（契约 §2，life-admin.ts 的 guard 风格）**，全部走 service 方法：
   - `GET  /api/admin/life/cities` → `location.listCities()`
   - `POST /api/admin/life/cities` → `location.createCity(body)`（建议入参：name/region/country/timeZone/active）
   - `PATCH /api/admin/life/cities/:id` → `location.updateCity(id, body)`
   - `GET  /api/admin/life/travel` → `{ travel: location.currentTravel() }`
   - `POST /api/admin/life/geocode/search` → `await location.geocodeSearch(query)`（候选不含 GPS）
   - （可选）`POST /api/admin/life/cities/:id/activate` 或复用 PATCH `{ active: true }`。
4. **engine / selector 调用点**：
   - `core/life2/engine.ts` 的 `this.location?.onActivityResolved(def, kind, planId, activityId)` **签名不变**，无需改动；线程标签通过 `setThreadsProvider` 注入（见上）。
   - `core/world-context.ts` 建议把 `timeZone: current?.timeZone ?? this.defaultTimeZone` 换成 `location.timeZoneFor(current)`，使城市切换后快照时区跟随；`travel` 字段可从 `location.currentTravel()` 取（WorldSnapshot 契约 §1.3 含 `travel`）。
   - selector 调用点（service 内部）已传入 `localHourAt(now, tz)` 与真实 `threadTags`；其他模块如需复用 `scoreLocationCandidates`，`hour` 必须用 `localHourAt` 计算，禁止 UTC+8。
5. **删除本 worktree 的临时 migration 901 与测试依赖**：测试均通过 harness（app 构造）驱动，不引用 901 版本号，合并后直接可用。

## KNOWN_RISKS

1. **到达时刻的语义**：惰性结算用 `expectedArriveAt` 作为 canonical 抵达时间写 state/visit（计划到达时刻，非发现时刻）；长时间无任何读取时"在途"状态会一直保留到下一次读取/活动解析，属设计内（无后台 worker 依赖）。
2. **哈希噪音与选择器边界**：选择器保留原有 ±4 确定性 hash 破平；线程标签加分（10/14/30）足够覆盖该噪音，但其他微小分差场景（如无线程、无 affinity 的 routine）获胜者仍可能受 hash 影响——与原版行为一致，未扩大随机面。
3. **旧库升级**：v19 库已有地点行（无 key）→ 不播种、不建边、不设家基线，`current()` 保持 null 直到首次活动解析/管理端 override（与原 v19 行为一致）；默认城市会自动补建。
4. **唯一 active 城市不变量**：`deactivate` 拒绝删除最后一个城市（返回 false）；停用 active 城市会自动补位最早创建的城市。跨城"搬家"语义由管理端决定（创建城市 + 创建地点 + travel/override 到达时自动切换）。
5. **override 是瞬移**：管理端覆盖即时生效并清空在途行程（有意为之，审计留痕）；旧行程不会在之后"补到账"。
6. **weatherConditionFor 回调**：构造第 4 参在 app.ts 引用 `weather.cachedCondition`，与城市切换后的坐标联动由 Integration 的 weather 侧保持（本模块只传当前/家作为查询目标）。
7. **测试仅限本模块**：按要求只跑了 location 三个测试文件（24/24，3 轮无 flake）；未跑全量套件，engine/weather 侧行为需 Integration 回归。
