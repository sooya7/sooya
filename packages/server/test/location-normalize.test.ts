import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

function localTime(iso: string): Date {
  return new Date(`${iso}+08:00`);
}

const ENV = { WORLD_CONTEXT_ENABLED: 'true', LOCATION_MODEL_ENABLED: 'true' };

/** 直接向 harness 的库写入"旧库"数据（绕过 service 播种），再重建 app 触发 normalization。 */
async function makeLegacyHarness(seed: (db: Harness['app']['db']['raw']) => void): Promise<Harness> {
  const first = await createHarness({ skipStickerImport: true, startWorkers: false, env: ENV, clock: () => localTime('2026-08-08T10:00') });
  const dataDir = first.app.env.dataDir;
  seed(first.app.db.raw);
  await first.app.close();
  const second = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ...ENV, DATA_DIR: dataDir }, clock: () => localTime('2026-08-08T10:00') });
  return second;
}

/**
 * 旧 Location 数据 normalization：无城市建宁波 / 有城市无 active 恢复已有 /
 * key 回填 / city_id 绑定 / state 修复 / travel 清理，全部幂等。
 */
describe('legacy location normalization', () => {
  it('completely empty city table creates Ningbo (only in that case)', async () => {
    harness = await createHarness({ skipStickerImport: true, startWorkers: false, env: ENV });
    const city = harness.app.services.location.activeCity()!;
    expect(city.name).toBe('宁波');
    expect(city.country).toBe('中国');
    expect(city.region).toBe('浙江');
    expect(city.timeZone).toBe('Asia/Shanghai');
  });

  it('existing cities without active: restores an existing legal city, never creates a duplicate Ningbo', async () => {
    const h = await makeLegacyHarness((db) => {
      // 旧库：两个城市都非 active（模拟旧版本没有 active 概念）。
      db.prepare("UPDATE life_cities SET active = 0").run();
      // 没有 key='default' 的城市。
      db.prepare("UPDATE life_cities SET key = NULL WHERE key = 'default'").run();
    });
    harness = h;
    const cities = harness.app.services.location.listCities();
    // 没有新增城市（数量与旧库一致：默认 1 个），也没有重复宁波。
    expect(cities.length).toBe(1);
    const active = harness.app.services.location.activeCity()!;
    expect(active.active).toBe(true);
  });

  it('existing Ningbo (key=default) wins restoration when nothing is active', async () => {
    const h = await makeLegacyHarness((db) => {
      db.prepare("UPDATE life_cities SET active = 0").run();
      db.prepare("INSERT INTO life_cities(id, key, name, region, country, time_zone, active, created_at, updated_at) VALUES ('city_extra','extra','上海','上海','中国','Asia/Shanghai',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
    });
    harness = h;
    const active = harness.app.services.location.activeCity()!;
    expect(active.name).toBe('宁波'); // key='default' 优先
    expect(harness.app.services.location.listCities().length).toBe(2);
  });

  it('backfills stable keys and binds city_id for recognizable legacy builtin/generated locations only', async () => {
    const h = await makeLegacyHarness((db) => {
      db.prepare("DELETE FROM life_locations").run();
      db.prepare("DELETE FROM life_cities").run();
      db.prepare("INSERT INTO life_cities(id, key, name, region, country, time_zone, active, created_at, updated_at) VALUES ('city_main','default','宁波','浙江','中国','Asia/Shanghai',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
      const now = '2026-01-01T00:00:00.000Z';
      for (const [name, kind] of [['家', 'home'], ['咖啡店', 'cafe'], ['社区公园', 'park'], ['图书馆', 'library']] as const) {
        db.prepare("INSERT INTO life_locations(id, key, name, kind, city_id, city, region, country, time_zone, lat, lng, tags_json, indoor, visit_weight, source, active, created_at, updated_at) VALUES (?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', 1, 1, 'builtin', 1, ?, ?)")
          .run(`loc_${name}`, name, kind, now, now);
      }
      // 用户自建地点：不猜 key。
      db.prepare("INSERT INTO life_locations(id, key, name, kind, city_id, city, region, country, time_zone, lat, lng, tags_json, indoor, visit_weight, source, active, created_at, updated_at) VALUES ('loc_custom','custom','外婆家的小院','other',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'[]',0,1,'admin',1,?,?)")
        .run(now, now);
    });
    harness = h;
    const locations = harness.app.services.location.list();
    const byName = new Map(locations.map((l) => [l.name, l]));
    expect(byName.get('家')?.key).toBe('home');
    expect(byName.get('咖啡店')?.key).toBe('cafe');
    expect(byName.get('社区公园')?.key).toBe('park');
    expect(byName.get('图书馆')?.key).toBe('library');
    // 用户自建地点 key 保持原样，不被猜测覆盖。
    expect(byName.get('外婆家的小院')?.key).toBe('custom');
    // builtin 地点已绑定 active city（宁波）。
    for (const name of ['家', '咖啡店', '社区公园', '图书馆']) {
      expect(byName.get(name)?.cityId).toBe(harness.app.services.location.activeCity()!.id);
    }
    // 用户自建地点不绑定（非 builtin/generated）。
    expect(byName.get('外婆家的小院')?.cityId).toBeNull();
  });

  it('repairs a current state pointing at an inactive location (home preferred)', async () => {
    const h = await makeLegacyHarness((db) => {
      // FK 开启的旧库不会出现"不存在"的引用；真实场景是被 admin 停用的地点。
      db.prepare("UPDATE life_locations SET active = 0 WHERE key = 'cafe'").run();
      db.prepare("UPDATE life_location_state SET location_id = (SELECT id FROM life_locations WHERE key = 'cafe')").run();
    });
    harness = h;
    const current = harness.app.services.location.current();
    expect(current).toBeTruthy();
    expect(current?.key).toBe('home');
  });

  it('clears a travel_state referencing inactive locations', async () => {
    const h = await makeLegacyHarness((db) => {
      db.prepare("UPDATE life_locations SET active = 0 WHERE key = 'park'").run();
      db.prepare("INSERT INTO travel_state(id, from_location_id, to_location_id, mode, started_at, expected_arrive_at, source_plan_id, source_activity_id, created_at) VALUES (1, (SELECT id FROM life_locations WHERE key = 'home'), (SELECT id FROM life_locations WHERE key = 'park'), 'walk', '2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z', NULL, NULL, '2026-01-01T00:00:00.000Z')").run();
    });
    harness = h;
    expect(harness.app.services.location.currentTravel()).toBeNull();
  });

  it('normalization is idempotent across restarts', async () => {
    // 旧库 → 第一次启动完成 normalization → 再重启不产生任何新增/改动。
    const first = await createHarness({ skipStickerImport: true, startWorkers: false, env: ENV, clock: () => localTime('2026-08-08T10:00') });
    const dataDir = first.app.env.dataDir;
    // 模拟旧库：地点无 key、城市无 active。
    first.app.db.raw.prepare("UPDATE life_locations SET key = NULL").run();
    first.app.db.raw.prepare("UPDATE life_cities SET active = 0").run();
    await first.app.close();

    const second = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ...ENV, DATA_DIR: dataDir }, clock: () => localTime('2026-08-08T10:00') });
    const cities = second.app.services.location.listCities();
    const locations = second.app.services.location.list();
    const state = second.app.services.location.currentState();
    const activeCity = second.app.services.location.activeCity()!;
    expect(activeCity.name).toBe('宁波');
    await second.app.close();

    const third = await createHarness({ skipStickerImport: true, startWorkers: false, env: { ...ENV, DATA_DIR: dataDir }, clock: () => localTime('2026-08-08T10:00') });
    harness = third;
    expect(third.app.services.location.listCities().length).toBe(cities.length);
    expect(third.app.services.location.list().length).toBe(locations.length);
    expect(third.app.services.location.currentState()?.location_id).toBe(state?.location_id);
    // 宁波仍是唯一 active 城市；key 保持已回填值。
    expect(third.app.services.location.listCities().filter((c) => c.active).length).toBe(1);
    expect(third.app.services.location.list().find((l) => l.name === '家')?.key).toBe('home');
  });
});
