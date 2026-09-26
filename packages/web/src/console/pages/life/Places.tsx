import { useState } from 'react';
import {
  adminApi, type AdminLifeLocation, type LifeCity, type TravelState, type WeatherForecastPeriod
} from '../../../lib/admin.js';
import { weatherConditionLabel } from '../../../lib/worldDisplay.js';
import { formatTemperature } from '../../../lib/numberDisplay.js';
import {
  Button, Callout, ConfirmButton, Empty, Facts, Field, Fields, Input, Loadable, Section, Select, Status, Switch, Tag,
  fmtDuration, useAction, useConsole, useLoad
} from '../../ui.js';
import { LOCATION_KINDS, TRAVEL_MODE, herDay, herToday, herWhen, locationKindLabel, useLife } from './shared.js';

interface World {
  locations: AdminLifeLocation[];
  current: AdminLifeLocation | null;
  travel: TravelState | null;
  cities: LifeCity[];
}

export function PlacesTab() {
  const { version } = useLife();
  const world = useLoad<World>(async () => {
    const [locations, travel, cities] = await Promise.all([adminApi.lifeLocations(), adminApi.lifeTravel(), adminApi.lifeCities()]);
    return { locations: locations.locations, current: locations.current, travel: travel.travel, cities: cities.cities };
  }, [version]);

  return (
    <>
      <Section title="她在哪" desc="她不会瞬移：换地方要在路上花时间，到了才算到。需要的话，你也可以直接把她放到某个地方。">
        <Loadable state={world} label="位置">{(data) => <WhereSection world={data} />}</Loadable>
      </Section>
      <Section title="她去的地方" desc="生活模拟会从这些地方里挑她去哪。常去程度越高，越常去。内置的地方属于她住的城市。">
        <Loadable state={world} label="地点">{(data) => <LocationsSection world={data} />}</Loadable>
      </Section>
      <Section title="城市" desc="她住在哪座城市。只支持中国城市，时间统一按北京时间。换城市后，地点、出行和天气都会跟着切过去。">
        <Loadable state={world} label="城市">{(data) => <CitiesSection world={data} />}</Loadable>
      </Section>
      <WeatherSection />
    </>
  );
}

/* ------------------------------------------------------ where + override */

function cityOf(location: AdminLifeLocation, cities: LifeCity[]): string | null {
  return (location.cityId && cities.find((c) => c.id === location.cityId)?.name) || location.city || null;
}

function WhereSection({ world }: { world: World }) {
  const { refresh, tz } = useLife();
  const { run, busy } = useAction();
  const { current, travel, locations, cities } = world;
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const nameOf = (id: string) => locations.find((l) => l.id === id)?.name ?? '一个已经删掉的地方';
  const chosen = locations.find((l) => l.id === target) ?? null;

  const override = async () => {
    if (!chosen) return;
    const result = await run('override', () => adminApi.overrideLocation(chosen.id, reason.trim() || '管理后台手动指定'), `她现在在${chosen.name}了`);
    if (result) { setReason(''); setTarget(''); refresh(); }
  };

  const options = [
    { value: '', label: '选一个地方' },
    ...locations.filter((l) => l.id !== current?.id).map((l) => {
      const city = cityOf(l, cities);
      return { value: l.id, label: city ? `${l.name}（${city}）` : l.name };
    })
  ];

  return (
    <>
      {current ? (
        <p className="cs-her-quote">
          {travel ? `她正从${nameOf(travel.fromLocationId)}去${nameOf(travel.toLocationId)}。` : `她在${current.name}。`}
        </p>
      ) : (
        <Callout tone="warn">
          {locations.length
            ? '现在没有确定她在哪，比如她所在的地方刚被删掉。在下面把她指定到一个地方，或者等生活模拟下次推进时她自己挪过去。'
            : '现在读不到她的位置：还没有任何地方，或者地点功能在部署配置里没有打开（LOCATION_MODEL_ENABLED）。先在下面加一个地方。'}
        </Callout>
      )}
      <Facts items={[
        ['地方', current ? (locationKindLabel(current.kind) === current.name ? current.name : `${current.name}，${locationKindLabel(current.kind)}`) : '—'],
        ['城市', current ? cityOf(current, cities) ?? '不属于哪座城市' : '—'],
        ['室内还是室外', current ? (current.indoor ? '室内' : '室外') : '—'],
        ['出行', travel ? `${TRAVEL_MODE[travel.mode] || '在路上'}，${herWhen(travel.startedAt, tz)} 出发` : '没在路上'],
        ['预计到达', travel ? herWhen(travel.expectedArriveAt, tz) : '—']
      ]} />
      <div className="life-subform" data-no-dirty>
        <h3 className="life-subhead">手动指定她在哪</h3>
        <Fields>
          <Field label="放到哪里">
            <Select value={target} options={options} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <Field label="原因" hint="会记进操作记录，可以不填。">
            <Input value={reason} maxLength={200} placeholder="比如：她说她去朋友家了" onChange={(e) => setReason(e.target.value)} />
          </Field>
        </Fields>
        <div className="cs-actions">
          <ConfirmButton
            label="把她放到这里"
            question={chosen ? `马上把她放到${chosen.name}${travel ? '，正在进行的出行会取消' : ''}${chosen.cityId && current?.cityId && chosen.cityId !== current.cityId ? '，城市也会一起换' : ''}。确定吗？` : ''}
            confirmLabel="确定放过去"
            disabled={!chosen}
            busy={busy === 'override'}
            onConfirm={override}
          />
          {!chosen && <span className="cs-muted life-hint">先选一个地方。</span>}
        </div>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- locations */

function LocationsSection({ world }: { world: World }) {
  const { refresh } = useLife();
  const { run, busy } = useAction();
  const { locations, current, cities } = world;

  const remove = async (location: AdminLifeLocation) => {
    const ok = await run(`del-${location.id}`, () => adminApi.deleteLocation(location.id), `${location.name}已删除`);
    if (ok) refresh();
  };

  return (
    <>
      {locations.length ? (
        <div className="cs-table-wrap">
          <table className="cs-table">
            <thead>
              <tr><th>名字</th><th>类型</th><th>城市</th><th>室内外</th><th>标签</th><th>常去程度</th><th>来源</th><th /></tr>
            </thead>
            <tbody>
              {locations.map((location) => (
                <tr key={location.id}>
                  <td>
                    <span className="cs-nowrap">{location.name}</span>
                    {location.id === current?.id && <> <Tag tone="ok">她在这里</Tag></>}
                  </td>
                  <td className="cs-nowrap">{locationKindLabel(location.kind)}</td>
                  <td className="cs-nowrap">{cityOf(location, cities) ?? <span className="cs-muted">不限</span>}</td>
                  <td className="cs-nowrap">{location.indoor ? '室内' : '室外'}</td>
                  <td>{location.tags.length ? location.tags.join('、') : <span className="cs-muted">—</span>}</td>
                  <td data-num>{location.visitWeight}</td>
                  <td className="cs-nowrap">{location.source === 'builtin' ? '内置' : location.source === 'admin' ? '你加的' : location.source === 'generated' ? '她发现的' : location.source}</td>
                  <td data-actions>
                    <ConfirmButton
                      label="删除"
                      question={location.id === current?.id ? `她现在就在${location.name}，删掉后她的位置会重新定。确定删除吗？` : `删除${location.name}？她以后不会再去这里。`}
                      confirmLabel="删除这个地方"
                      busy={busy === `del-${location.id}`}
                      onConfirm={() => remove(location)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>还没有任何地方。在下面加一个，她才有地方可去。</Empty>
      )}
      <div className="life-subform">
        <h3 className="life-subhead">加一个地方</h3>
        <LocationForm onDone={refresh} />
      </div>
    </>
  );
}

function LocationForm({ onDone }: { onDone: () => void }) {
  const { touch, settle } = useLife();
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('cafe');
  const [indoor, setIndoor] = useState(true);
  const [tags, setTags] = useState('');
  const [weight, setWeight] = useState('1');
  const [error, setError] = useState<{ name?: string; weight?: string }>({});

  const submit = async () => {
    const w = Number(weight);
    const next: typeof error = {};
    if (!name.trim()) next.name = '写一下这个地方叫什么。';
    if (!Number.isFinite(w) || w < 0 || w > 10) next.weight = '填 0 到 10 之间的数。';
    setError(next);
    if (next.name || next.weight) return;
    const tagList = tags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
    const result = await run('loc-new', () => adminApi.createLocation({ name: name.trim(), kind, indoor, tags: tagList, visitWeight: w }), `${name.trim()}已加上`);
    if (!result) return;
    setName(''); setTags(''); setWeight('1');
    settle('loc-new');
    onDone();
  };
  const edit = () => touch('loc-new');

  return (
    <div className="life-form" onInput={edit}>
      <Fields>
        <Field label="叫什么" error={error.name}>
          <Input value={name} maxLength={120} placeholder="比如：学校后门的面馆" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="是什么地方">
          <Select value={kind} options={LOCATION_KINDS} onChange={(e) => { setKind(e.target.value); edit(); }} />
        </Field>
        <Field label="标签" hint="用逗号隔开，比如：安静，看书。帮她判断什么时候适合来。">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="常去程度" hint="0 到 10，默认 1；0 表示几乎不去。" error={error.weight}>
          <Input type="number" min={0} max={10} step={0.5} value={weight} onChange={(e) => setWeight(e.target.value)} />
        </Field>
      </Fields>
      <Switch checked={indoor} onChange={(v) => { setIndoor(v); edit(); }} label="在室内（下雨也能去）" />
      <p className="cs-muted life-hint">你加的地方不绑定城市，换城市后她仍然可能去。</p>
      <div className="cs-actions">
        <Button size="sm" busy={busy === 'loc-new'} onClick={() => void submit()}>加上这个地方</Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ cities */

function CitiesSection({ world }: { world: World }) {
  const { refresh } = useLife();
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<string | null>(null);

  const activate = async (city: LifeCity) => {
    const ok = await run(`city-${city.id}`, () => adminApi.updateCity(city.id, { active: true }), `她搬到${city.name}了`);
    if (ok) refresh();
  };

  return (
    <>
      {world.cities.length ? (
        <div className="cs-list life-stack">
          {world.cities.map((city) => (
            <div className="cs-list-item" key={city.id}>
              <span>
                <span className="cs-list-title">{city.name}</span>{' '}
                {city.active && <Tag tone="ok">她住在这里</Tag>}
              </span>
              <span className="cs-list-side">
                {!city.active && (
                  <ConfirmButton
                    label="搬到这里"
                    question={`让她搬到${city.name}？进行中的出行会取消，天气会换成那边的。`}
                    confirmLabel="确定搬过去"
                    busy={busy === `city-${city.id}`}
                    onConfirm={() => activate(city)}
                  />
                )}
                <Button kind="text" size="sm" onClick={() => setEditing(editing === city.id ? null : city.id)}>{editing === city.id ? '收起' : '改名字'}</Button>
              </span>
              <span className="cs-list-meta">{[city.region, city.country].filter(Boolean).join('，') || '没填省份'}</span>
              {editing === city.id && (
                <div className="cs-list-body">
                  <CityForm city={city} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty>还没有城市。加一座，第一座会自动成为她住的地方。</Empty>
      )}
      <div className="life-subform">
        <h3 className="life-subhead">加一座城市</h3>
        <CityForm onDone={refresh} />
      </div>
    </>
  );
}

function CityForm({ city, onDone, onCancel }: { city?: LifeCity; onDone: () => void; onCancel?: () => void }) {
  const { touch, settle } = useLife();
  const { run, busy } = useAction();
  const key = city ? `city-edit-${city.id}` : 'city-new';
  const [name, setName] = useState(city?.name ?? '');
  const [region, setRegion] = useState(city?.region ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) { setError('写一下城市名。'); return; }
    const result = city
      ? await run(key, () => adminApi.updateCity(city.id, { name: name.trim(), region: region.trim() || null }), '城市信息已保存')
      : await run(key, () => adminApi.createCity({ name: name.trim(), ...(region.trim() ? { region: region.trim() } : {}) }), `${name.trim()}已加上`);
    if (!result) return;
    if (!city) { setName(''); setRegion(''); }
    settle(key);
    onDone();
  };

  return (
    <div className="life-form" onInput={() => { touch(key); setError(null); }}>
      <Fields>
        <Field label="城市" error={error}>
          <Input value={name} maxLength={80} placeholder="比如：杭州" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="省份" hint="可以不填。">
          <Input value={region} maxLength={80} placeholder="比如：浙江" onChange={(e) => setRegion(e.target.value)} />
        </Field>
      </Fields>
      <div className="cs-actions">
        <Button size="sm" busy={busy === key} onClick={() => void submit()}>{city ? '保存城市信息' : '加上这座城市'}</Button>
        {onCancel && <Button kind="text" size="sm" onClick={() => { settle(key); onCancel(); }}>取消</Button>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- weather */

function dayLabel(iso: string, tz: number): string {
  const day = herDay(iso, tz);
  const today = herToday(tz);
  if (!day) return '—';
  if (day === today) return '今天';
  if (day === herDay(new Date(Date.parse(`${today}T00:00:00Z`) + 36 * 3600_000).toISOString(), 0)) return '明天';
  const [, m, d] = day.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function periodRow(period: WeatherForecastPeriod, tz: number, daily: boolean) {
  return (
    <tr key={period.at}>
      <td className="cs-nowrap">{daily ? dayLabel(period.at, tz) : herWhen(period.at, tz)}</td>
      <td className="cs-nowrap">{weatherConditionLabel(period.condition)}</td>
      <td data-num>{formatTemperature(period.temperatureC)}</td>
      <td data-num>{period.precipitationMm == null ? '—' : `${period.precipitationMm} 毫米`}</td>
      <td data-num>{period.windKph == null ? '—' : `${Math.round(period.windKph)} 公里/时`}</td>
    </tr>
  );
}

function providerLabel(name: string | null | undefined): string {
  if (!name) return '未知来源';
  if (name === 'fallback') return '内置的估算天气（没有接真实天气服务）';
  return name;
}

function WeatherSection() {
  const { version, refresh, tz } = useLife();
  const { notify } = useConsole();
  const { run, busy } = useAction();
  const status = useLoad(() => adminApi.weatherStatus(), [version]);
  const forecast = useLoad(() => adminApi.weatherForecast(), [version]);

  const doRefresh = async () => {
    const result = await run('weather', () => adminApi.weatherRefresh());
    if (!result) return;
    notify(result.snapshot ? '天气已更新' : '天气服务没有返回数据，稍后再试一次', result.snapshot ? 'ok' : 'bad');
    refresh();
  };

  return (
    <Section title="天气" desc="她那边的天气。下雨、降温这些会影响她出不出门、心情怎样，也会写进生活事件。">
      <Loadable state={status} label="天气">
        {(data) => {
          const snap = data.lastSnapshot;
          const refreshButton = (
            <Button kind="quiet" size="sm" busy={busy === 'weather'} disabled={!data.enabled} onClick={() => void doRefresh()}>重新取一次天气</Button>
          );
          if (!data.enabled) {
            return (
              <Callout tone="warn">
                {data.provider.configured
                  ? '天气功能在部署配置里没有打开（WEATHER_ENABLED 和 WORLD_CONTEXT_ENABLED），她那边暂时当作没有天气。要打开得改服务器的 .env 再重启服务。'
                  : '没有可用的天气服务，她那边暂时当作没有天气。天气服务在服务器的 .env 里配置，改完需要重启服务。'}
              </Callout>
            );
          }
          return (
            <>
              <div className="cs-actions life-weather-head">
                <Status tone={!snap ? 'off' : snap.stale ? 'warn' : 'ok'}>
                  {!snap ? '还没取到天气' : snap.stale ? '天气数据有点旧了' : '天气是新的'}
                </Status>
                {refreshButton}
              </div>
              {snap ? (
                <>
                  <p className="cs-her-quote">
                    {weatherConditionLabel(snap.condition)}{snap.temperatureC == null ? '' : `，${formatTemperature(snap.temperatureC)}`}
                    {snap.feelsLikeC == null ? '' : `，体感 ${formatTemperature(snap.feelsLikeC)}`}。
                  </p>
                  <Facts items={[
                    ['湿度', snap.humidity == null ? '—' : `${Math.round(snap.humidity)}%`],
                    ['降水', snap.precipitationMm == null ? '—' : `${snap.precipitationMm} 毫米`],
                    ['风', snap.windKph == null ? '—' : `${Math.round(snap.windKph)} 公里/时`],
                    ['日出日落', data.daylight ? `${herWhen(data.daylight.sunrise, tz)} 日出，${herWhen(data.daylight.sunset, tz)} 日落` : '—'],
                    ['观测时间', `${herWhen(snap.observedAt, tz)}${data.cacheAgeSec == null ? '' : `（${data.cacheAgeSec < 60 ? '刚刚' : `${fmtDuration(data.cacheAgeSec)}前`}）`}`],
                    ['数据来源', providerLabel(data.currentSource ?? data.provider.name)]
                  ]} />
                </>
              ) : (
                <p className="cs-muted">天气服务是{providerLabel(data.provider.name)}，但还没取过数据。点“重新取一次天气”试试。</p>
              )}
            </>
          );
        }}
      </Loadable>
      <Loadable state={forecast} label="天气预报">
        {({ forecast: f }) => {
          if (!f) return status.data?.enabled && status.data.provider.configured ? <p className="cs-muted">还没有预报。取到天气后会一起更新。</p> : null;
          // The provider sometimes hands back hours from earlier today; only show what is still ahead.
          const ahead = f.next12h.filter((p) => Date.parse(p.at) >= Date.now() - 3600_000);
          return (
            <>
              {f.severe && <Callout tone="warn">接下来有恶劣天气，她可能会取消出门的计划。</Callout>}
              {f.next12h.length > 0 && ahead.length === 0 && (
                <p className="cs-muted">逐小时预报里只有今天早些时候的数据，没有接下来几个小时的。可以点“重新取一次天气”再试。</p>
              )}
              {ahead.length > 0 && (
                <div>
                  <h3 className="life-subhead">接下来几个小时</h3>
                  <div className="cs-table-wrap">
                    <table className="cs-table">
                      <thead><tr><th>时间</th><th>天气</th><th>气温</th><th>降水</th><th>风</th></tr></thead>
                      <tbody>{ahead.map((p) => periodRow(p, tz, false))}</tbody>
                    </table>
                  </div>
                </div>
              )}
              {f.next3d.length > 0 && (
                <div>
                  <h3 className="life-subhead">接下来 3 天</h3>
                  <div className="cs-table-wrap">
                    <table className="cs-table">
                      <thead><tr><th>日期</th><th>天气</th><th>气温</th><th>降水</th><th>风</th></tr></thead>
                      <tbody>{f.next3d.map((p) => periodRow(p, tz, true))}</tbody>
                    </table>
                  </div>
                </div>
              )}
              <p className="cs-muted life-hint">预报来源：{providerLabel(f.provider)}，{herWhen(f.generatedAt, tz)} 生成。</p>
            </>
          );
        }}
      </Loadable>
    </Section>
  );
}
