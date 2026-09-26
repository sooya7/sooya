import { useState, type FormEvent, type ReactNode } from 'react';
import {
  adminApi, adminRequest, type AdminActivityItem, type AdminMemory, type AdminOmbreStatus, type AdminRecallTrace, type AdminRecallTraceEntry
} from '../../lib/admin.js';
import { ApiError } from '../../lib/api.js';
import { consolePath } from '../routes.js';
import {
  Button, Callout, ConfirmButton, Empty, Facts, Field, Input, Loadable, Loading, Page, Section, Select, Status, Tabs, Tag,
  errorMessage, fmtAgo, fmtTime, useAction, useConsole, useLoad, type Loaded, type Tone
} from '../ui.js';
import './Memory.css';

/* ---------------------------------------------------------------- types */

type Backend = 'legacy' | 'ombre';

interface MemoryStats { total: number; withEmbedding: number; coverage: number; byKind: Record<string, number> }

/** GET /api/admin/memories — `backend` is the server's real MEMORY_BACKEND switch. */
interface MemoriesResponse {
  memories: AdminMemory[];
  backend?: Backend;
  readOnly?: boolean;
  stats: MemoryStats;
  recall?: AdminRecallTrace;
}

interface OmbreHealth {
  id?: string; enabled?: boolean; state?: string; toolCount?: number; latencyMs?: number;
  lastError?: string; lastConnectedAt?: string; lastRefreshAt?: string;
}

interface OmbreCommit { batch_id?: string; revision?: number; state?: string; started_at?: string | null; completed_at?: string | null }

const PAGE_SIZE = 30;

/* --------------------------------------------------------------- labels */

const KIND_LABELS: Record<string, string> = {
  profile: '关于你',
  preference: '喜好',
  relationship: '你们的关系',
  project: '在忙的事',
  event: '发生过的事',
  summary: '阶段总结',
  fact: '事实'
};
const KIND_ORDER = ['profile', 'preference', 'relationship', 'project', 'event', 'summary'];

const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

const RECALL_STRATEGY: Record<string, string> = {
  none: '没有去找',
  embedding: '按意思找（语义向量）',
  fts: '按关键词找',
  ombre: '交给 Ombre'
};

const RECALL_FALLBACK: Record<string, string> = {
  'no memories stored': '她还没有记住任何事',
  'memory disabled': '记忆功能没有开启',
  'embedding provider not configured': '还没有配置记忆向量模型，只能按关键词找',
  'no memories carry embeddings of the current dimension': '现有记忆都没有和当前向量模型匹配的向量，只能按关键词找'
};

function recallFallbackText(value: string): string {
  if (RECALL_FALLBACK[value]) return RECALL_FALLBACK[value]!;
  if (value.startsWith('embedding dimension mismatch')) return '向量模型换过，维度对不上，只能按关键词找';
  if (value.startsWith('embedding provider failed')) return `向量模型调用失败，只能按关键词找（${value.replace(/^embedding provider failed:\s*/, '')}）`;
  return value;
}

const RECALL_DROP: Record<string, string> = {
  deduplicated_persona: '人设里已经写了',
  deduplicated_summary: '阶段总结里已经有了',
  deduplicated_recent: '最近的聊天里刚说过',
  deduplicated_future: '和约好的事重复',
  budget: '篇幅放不下'
};

function recallReasonText(value: string): string {
  if (value === 'FTS lexical match') return '关键词对上了';
  const embedding = /^embedding cosine ([\d.]+)(, reranked)?$/.exec(value);
  if (embedding) return `意思相近度 ${Number(embedding[1]).toFixed(2)}${embedding[2] ? '，重新排过序' : ''}`;
  return value;
}

const COMMIT_STATE: Record<string, string> = {
  running: '正在写入',
  completed: '写入成功',
  uncertain: '不确定是否写入成功',
  failed: '写入失败',
  skipped: '没有需要写入的'
};

const ACTIVITY_LABELS: Record<string, string> = {
  'ombre.memory.search': '在这里搜索了记忆',
  'ombre.memory.commit': '把聊天写进记忆',
  'ombre.memory.commit_recovered': '补写了一次记忆',
  'ombre.memory.commit_skipped': '这次没有需要写入的',
  'ombre.memory.dream': '整理了一遍记忆',
  'ombre.memory.error': '记忆服务出错',
  'ombre.memory.wake': '回复前唤起记忆',
  'mcp.connect_success': '连上了外部服务',
  'mcp.connect_failure': '连不上外部服务',
  'mcp.reconnect_attempt': '尝试重新连接',
  'mcp.reconnect_success': '重新连上了',
  'mcp.reconnect_failure': '重新连接失败',
  'mcp.tools_refresh': '刷新了工具列表',
  'mcp.tools_refresh_failure': '刷新工具列表失败'
};

function activityTone(type: string): 'bad' | undefined {
  return /failure|error|failed/.test(type) ? 'bad' : undefined;
}

function activityDetail(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  const d = detail;
  if (d.serverId !== undefined) parts.push(`服务 ${String(d.serverId)}`);
  if (d.queryLength !== undefined) parts.push(`搜索词 ${String(d.queryLength)} 个字`);
  if (d.resultCount !== undefined) parts.push(`找到 ${String(d.resultCount)} 条`);
  if (d.state !== undefined) parts.push(COMMIT_STATE[String(d.state)] ?? String(d.state));
  if (d.callsExecuted !== undefined) parts.push(`调用 ${String(d.callsExecuted)} 次`);
  if (d.rounds !== undefined) parts.push(`${String(d.rounds)} 轮`);
  if (d.recovered !== undefined) parts.push(d.recovered ? '已恢复' : '未恢复');
  if (d.reason !== undefined) parts.push(`原因：${String(d.reason)}`);
  if (d.error !== undefined) parts.push(`错误：${String(d.error)}`);
  return parts.join('，');
}

function pct(value: number): string {
  const n = Number.isFinite(value) ? value : 0;
  return `${Math.round((n > 1 ? n / 100 : n) * 100)}%`;
}

/* ------------------------------------------------------------ helpers */

function Pager({ offset, count, total, onChange }: { offset: number; count: number; total: number; onChange: (next: number) => void }) {
  if (total <= PAGE_SIZE && offset === 0) return null;
  return (
    <div className="cs-actions mem-pager" data-no-dirty>
      <span className="cs-muted">第 {count ? offset + 1 : 0}–{offset + count} 条，共 {total} 条</span>
      <Button kind="quiet" size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>上一页</Button>
      <Button kind="quiet" size="sm" disabled={offset + count >= total} onClick={() => onChange(offset + PAGE_SIZE)}>下一页</Button>
    </div>
  );
}

function MemoryItem({ memory, action }: { memory: AdminMemory; action?: ReactNode }) {
  return (
    <div className="cs-list-item mem-item">
      <p className="mem-text">{memory.content}</p>
      <span className="mem-meta">
        <Tag>{kindLabel(memory.kind)}</Tag>
        <span>重要程度 {pct(memory.importance)}</span>
        <span>把握 {pct(memory.confidence)}</span>
        {memory.hits > 0 && <span>想起过 {memory.hits} 次</span>}
        {memory.hasEmbedding === false && <span>还不能按意思找到</span>}
        <span title={fmtTime(memory.updatedAt, true)}>{fmtAgo(memory.updatedAt)}更新</span>
      </span>
      {action && <span className="cs-list-side">{action}</span>}
    </div>
  );
}

/* ================================================================ page */

export default function Memory() {
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const listing = useLoad(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (kind) params.set('kind', kind);
    return adminRequest<MemoriesResponse>(`/api/admin/memories?${params}`);
  }, [kind, offset]);
  const status = useLoad(() => adminApi.ombreStatus());
  const [tab, setTab] = useState<Backend | null>(null);

  // /memory/status only describes Ombre (it always says backend: 'ombre'); which store she
  // actually reads is the MEMORY_BACKEND switch reported by /memories. Fall back to status
  // only when the listing is unreachable.
  const backend: Backend | null = listing.data
    ? listing.data.backend ?? (listing.data.readOnly ? 'ombre' : 'legacy')
    : listing.error && status.data ? status.data.backend : null;
  const current: Backend = tab ?? backend ?? 'legacy';

  return (
    <Page title="记忆" register="her" intro="她记住的关于你的事，以及每次回复前她想起了哪些。">
      <Section title="她的记忆放在哪" desc="记忆可以存在 SOOYA 自己的数据库里，也可以交给外部的 Ombre 记忆服务。">
        {backend === null ? (
          listing.error && status.error
            ? <Callout tone="bad">读不到记忆的状态：{errorMessage(listing.error)} <Button kind="text" size="sm" onClick={() => { void listing.reload(); void status.reload(); }}>重试</Button></Callout>
            : <Loading />
        ) : (
          <BackendSummary backend={backend} stats={listing.data?.stats ?? null} status={status.data} />
        )}
      </Section>

      <div data-no-dirty>
        <Tabs<Backend>
          label="记忆来源"
          value={current}
          onChange={setTab}
          tabs={[
            { id: 'legacy', label: backend === 'legacy' ? '内置记忆（正在用）' : '内置记忆' },
            { id: 'ombre', label: backend === 'ombre' ? 'Ombre（正在用）' : 'Ombre' }
          ]}
        />
      </div>

      <div role="tabpanel">
        {current === 'legacy'
          ? backend === 'ombre'
            ? <LegacyReadOnly dashboardUrl={status.data?.dashboardUrl ?? null} />
            : <BuiltinMemories listing={listing} kind={kind} offset={offset} setKind={(k) => { setKind(k); setOffset(0); }} setOffset={setOffset} />
          : <OmbreView status={status} backend={backend} />}
      </div>
    </Page>
  );
}

function BackendSummary({ backend, stats, status }: { backend: Backend; stats: MemoryStats | null; status: AdminOmbreStatus | null }) {
  if (backend === 'legacy') {
    return (
      <>
        <Status tone="ok">她现在用的是内置记忆</Status>
        <p>她的记忆存在 SOOYA 自己的数据库里，可以在下面查看、删除，或者全部清空。</p>
        {stats && (
          <Facts items={[
            ['一共记得', `${stats.total.toLocaleString()} 条`],
            ['能按意思想起', stats.total ? `${stats.withEmbedding.toLocaleString()} 条（${pct(stats.coverage)}）` : '—']
          ]} />
        )}
        <p className="cs-muted">要换成 Ombre，需要在服务器配置里把 MEMORY_BACKEND 改成 ombre 并重启服务。</p>
      </>
    );
  }
  const connected = status?.connection === 'connected';
  return (
    <>
      <Status tone={status ? (connected ? 'ok' : 'warn') : 'off'}>
        {status ? (connected ? '她现在用的是 Ombre，连接正常' : '她现在用的是 Ombre，但现在连不上') : '她现在用的是 Ombre'}
      </Status>
      <p>她的记忆交给 Ombre 管理。这里可以查看连接情况、搜索她记得的事；要修改或删除记忆，请到 Ombre 自己的管理面板。</p>
      {status?.dashboardUrl && <p><a href={status.dashboardUrl} target="_blank" rel="noreferrer">打开 Ombre 管理面板</a></p>}
      <p className="cs-muted">要换回内置记忆，需要在服务器配置里把 MEMORY_BACKEND 改成 legacy 并重启服务。</p>
    </>
  );
}

/* ------------------------------------------------------ builtin memory */

function BuiltinMemories({ listing, kind, offset, setKind, setOffset }: {
  listing: Loaded<MemoriesResponse>; kind: string; offset: number; setKind: (kind: string) => void; setOffset: (offset: number) => void;
}) {
  const { navigate, notify } = useConsole();
  const { run, busy } = useAction();

  const remove = async (memory: AdminMemory, pageCount: number) => {
    const done = await run(`delete:${memory.id}`, () => adminApi.deleteMemory(memory.id), '这条记忆已删除');
    if (done === undefined) return;
    if (pageCount === 1 && offset > 0) setOffset(Math.max(0, offset - PAGE_SIZE));
    else await listing.reload();
  };

  const clear = async () => {
    const result = await run('clear', () => adminApi.clearMemories() as Promise<{ cleared: boolean; memories?: number; summaries?: number }>);
    if (!result) return;
    const detail = result.memories !== undefined ? `（${result.memories} 条记忆，${result.summaries ?? 0} 条阶段总结）` : '';
    notify(`全部记忆已清空${detail}`, 'ok');
    // Changing the filter or page reloads by itself; only reload when neither moves.
    if (kind || offset) { setKind(''); setOffset(0); } else await listing.reload();
  };

  return (
    <>
      <Section title="她记得的" desc="按重要程度排列。删掉的记忆她以后就想不起来了。">
        <Loadable state={listing} label="记忆">
          {({ memories, stats }) => {
            const total = kind ? stats.byKind[kind] ?? 0 : stats.total;
            const kinds = [...new Set([...KIND_ORDER.filter((k) => stats.byKind[k]), ...Object.keys(stats.byKind)])];
            return (
              <>
                {stats.total > 0 && (
                  <div className="mem-toolbar" data-no-dirty>
                    <Field label="只看哪一类">
                      <Select
                        value={kind}
                        onChange={(e) => setKind(e.target.value)}
                        options={[
                          { value: '', label: `全部（${stats.total}）` },
                          ...kinds.map((k) => ({ value: k, label: `${kindLabel(k)}（${stats.byKind[k] ?? 0}）` }))
                        ]}
                      />
                    </Field>
                    <Button kind="text" size="sm" busy={listing.loading} onClick={() => void listing.reload()}>刷新</Button>
                  </div>
                )}
                {memories.length === 0 ? (
                  stats.total === 0
                    ? <Empty>她还没有记住关于你的事。在 QQ 上多和她聊聊，她会慢慢记下你说过的喜好、近况和你们之间的事。</Empty>
                    : <Empty action={<Button kind="quiet" size="sm" onClick={() => setKind('')}>看全部记忆</Button>}>这一类下面没有记忆。</Empty>
                ) : (
                  <div className="cs-list">
                    {memories.map((memory) => (
                      <MemoryItem
                        key={memory.id}
                        memory={memory}
                        action={
                          <ConfirmButton
                            label="删除这条记忆"
                            question="删除后她就想不起来了。"
                            confirmLabel="确定删除"
                            busy={busy === `delete:${memory.id}`}
                            onConfirm={() => remove(memory, memories.length)}
                          />
                        }
                      />
                    ))}
                  </div>
                )}
                <Pager offset={offset} count={memories.length} total={total} onChange={setOffset} />
              </>
            );
          }}
        </Loadable>
      </Section>

      {listing.data && (
        <Section title="上一次回复想起了什么" desc="她回复前会先翻一遍记忆。这里是最近一次翻到的内容，以及哪些真正用进了回复。">
          {listing.data.recall
            ? <RecallTrace recall={listing.data.recall} onConfigure={() => navigate(consolePath('models'))} />
            : <Empty>服务器这次没有返回召回记录。</Empty>}
        </Section>
      )}

      <Section title="清空全部记忆" desc="删掉她记住的所有事，连同对你们聊天的阶段总结。聊天记录本身不受影响。删了不能恢复，建议先备份。">
        <div className="cs-actions">
          <ConfirmButton
            label="清空全部记忆"
            question={listing.data ? `确定清空全部 ${listing.data.stats.total} 条记忆和阶段总结？删了不能恢复。` : '确定清空全部记忆和阶段总结？删了不能恢复。'}
            confirmLabel="确定清空"
            busy={busy === 'clear'}
            onConfirm={clear}
          />
          <Button kind="text" size="sm" onClick={() => navigate(consolePath('storage'))}>先去备份</Button>
        </div>
      </Section>
    </>
  );
}

function RecallTrace({ recall, onConfigure }: { recall: AdminRecallTrace; onConfigure: () => void }) {
  if (!recall.query && recall.entries.length === 0 && recall.strategy === 'none' && !recall.fallbackReason) {
    return <Empty>她还没有回复过，或者上一次回复没有去翻记忆。</Empty>;
  }
  const needsEmbedding = recall.fallbackReason === 'embedding provider not configured' || recall.fallbackReason?.startsWith('embedding');
  return (
    <>
      {recall.query && (
        <div className="mem-query">
          <span className="cs-muted">拿这句话去找</span>
          <p>「{recall.query}」</p>
        </div>
      )}
      <Facts items={[
        ['找的方式', RECALL_STRATEGY[recall.strategy] ?? recall.strategy],
        ['翻到', `${recall.stats.recalled} 条`],
        ['用进回复', `${recall.stats.included} 条`],
        ['别处已有而跳过', `${recall.stats.deduplicated} 条`],
        ['篇幅放不下', `${recall.stats.budgetDropped} 条`]
      ]} />
      {recall.fallbackReason && (
        <Callout tone="warn">
          {recallFallbackText(recall.fallbackReason)}。
          {needsEmbedding && <> <Button kind="text" size="sm" onClick={onConfigure}>去配置记忆向量模型</Button></>}
        </Callout>
      )}
      {recall.entries.length === 0
        ? <Empty>这次没有翻到相关的记忆。</Empty>
        : (
          <div className="cs-list">
            {recall.entries.map((entry) => <RecallEntry key={entry.id} entry={entry} />)}
          </div>
        )}
    </>
  );
}

function RecallEntry({ entry }: { entry: AdminRecallTraceEntry }) {
  return (
    <div className="cs-list-item mem-item" data-dropped={entry.included ? undefined : 'true'}>
      <p className="mem-text">{entry.content}</p>
      <span className="mem-meta">
        {entry.included ? <Tag tone="ok">用进了回复</Tag> : <Tag>没用上：{RECALL_DROP[entry.droppedReason ?? ''] ?? entry.droppedReason ?? '原因不明'}</Tag>}
        <span>{kindLabel(entry.kind)}</span>
        <span>{recallReasonText(entry.reason)}</span>
      </span>
    </div>
  );
}

/* ------------------------------------------- legacy (read-only) under Ombre */

function LegacyReadOnly({ dashboardUrl }: { dashboardUrl: string | null }) {
  const [offset, setOffset] = useState(0);
  const legacy = useLoad(() => adminApi.legacyMemories(PAGE_SIZE, offset), [offset]);
  return (
    <>
      <Section title="切换前的内置记忆" desc="换成 Ombre 之前，她在 SOOYA 里记下的内容。现在她不会读这些，这里只能查看；将来换回内置记忆时它们还在。">
        <Callout>
          现在用的是 Ombre，这里不能删除或清空记忆。{dashboardUrl ? <>要修改她的记忆，请到 <a href={dashboardUrl} target="_blank" rel="noreferrer">Ombre 管理面板</a>。</> : '要修改她的记忆，请到 Ombre 自己的管理面板。'}
        </Callout>
        <Loadable state={legacy} label="旧的内置记忆">
          {({ memories, total }) => memories.length === 0 && offset === 0
            ? <Empty>SOOYA 里没有留下旧的内置记忆。</Empty>
            : (
              <>
                <div className="cs-list">
                  {memories.map((memory) => <MemoryItem key={memory.id} memory={memory} />)}
                </div>
                <Pager offset={offset} count={memories.length} total={total} onChange={setOffset} />
              </>
            )}
        </Loadable>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------- Ombre */

function OmbreView({ status, backend }: { status: Loaded<AdminOmbreStatus>; backend: Backend | null }) {
  const { navigate } = useConsole();
  const activity = useLoad(() => adminApi.ombreActivity(50));
  return (
    <>
      <Section title="连接情况" desc="Ombre 是单独运行的记忆服务，SOOYA 通过它读写她的记忆。">
        {backend === 'legacy' && (
          <Callout>现在用的是内置记忆，Ombre 没有参与她的回复。下面的连接情况只是参考。</Callout>
        )}
        <Loadable state={status} label="Ombre 状态">
          {(data) => <OmbreStatusView status={data} reloading={status.loading} onReload={() => void status.reload()} onTools={() => navigate(consolePath('tools'))} />}
        </Loadable>
      </Section>

      <OmbreSearch onSearched={() => void activity.reload()} />
      <OmbreCatalog />

      <Section title="最近活动" desc="记忆服务和外部连接最近发生的事。只记摘要，不含记忆正文。">
        <Loadable state={activity} label="最近活动">
          {({ activity: items }) => <ActivityList items={items} loading={activity.loading} onReload={() => void activity.reload()} />}
        </Loadable>
      </Section>
    </>
  );
}

function OmbreStatusView({ status, reloading, onReload, onTools }: {
  status: AdminOmbreStatus; reloading: boolean; onReload: () => void; onTools: () => void;
}) {
  const health = status.health as OmbreHealth | null;
  const commit = status.lastCommit as OmbreCommit | null;
  const tone: Tone = !health || health.state === 'disabled' || health.enabled === false ? 'off' : status.connection === 'connected' ? 'ok' : 'warn';
  const label = !health ? '没有配置 Ombre'
    : health.state === 'disabled' || health.enabled === false ? 'Ombre 没有启用'
      : status.connection === 'connected' ? '已连接' : health.state === 'connecting' ? '正在连接' : '连接不正常';
  return (
    <>
      <div className="cs-actions mem-status-line">
        <Status tone={tone}>{label}</Status>
        <Button kind="text" size="sm" busy={reloading} onClick={onReload}>刷新</Button>
      </div>
      {health?.lastError && (
        <Callout tone="bad">
          最近一次出错：{health.lastError}。检查服务器上 Ombre 的地址和令牌，改好后到工具页面重新连接。{' '}
          <Button kind="text" size="sm" onClick={onTools}>去工具页面</Button>
        </Callout>
      )}
      {!health && <p className="cs-muted">服务器上没有配置名为 ombre 的外部服务。</p>}
      <Facts items={[
        ['可用工具', health ? `${health.toolCount ?? 0} 个` : '—'],
        ['响应时间', health?.latencyMs !== undefined ? `${Math.round(health.latencyMs)} 毫秒` : '—'],
        ['最近连上', health?.lastConnectedAt ? fmtAgo(health.lastConnectedAt) : '还没连上过'],
        ['最近一次写入记忆', commit ? `${COMMIT_STATE[commit.state ?? ''] ?? commit.state ?? '已记录'}，${fmtAgo(commit.completed_at ?? commit.started_at)}` : '还没有'],
        ['正在写入', `${status.pending} 次`],
        ['结果不确定', `${status.uncertain} 次`],
        ['最近一次整理记忆', status.lastDream ? fmtAgo(status.lastDream) : '还没整理过'],
        ['管理面板', status.dashboardUrl ? <a href={status.dashboardUrl} target="_blank" rel="noreferrer">打开</a> : '没有配置']
      ]} />
      {status.uncertain > 0 && (
        <Callout tone="warn">有 {status.uncertain} 次写入没有确认是否成功，那几段聊天她可能没记住。可以到 Ombre 管理面板核对。</Callout>
      )}
    </>
  );
}

/** Ombre wraps each hit with `bucket_id:` / `score:` / `known:` lines; those are shown as metadata instead. */
function searchText(raw: unknown): string {
  const text = String(raw ?? '');
  const body = text.split(/\r?\n/).filter((line) => !/^\s*(bucket_id|bucketId|score|known)\s*:/i.test(line)).join('\n').trim();
  return body || text;
}

type SearchResult = { query: string; results: Array<Record<string, unknown>>; raw: string; resultCount: number };

function OmbreSearch({ onSearched }: { onSearched: () => void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await adminApi.ombreSearch(q, 10));
      onSearched();
    } catch (e) {
      setError(e);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="搜一搜她记得什么" desc="直接在 Ombre 里按意思搜索。只是查看，不会影响她的回复。">
      <form className="mem-search" onSubmit={search} data-no-dirty>
        <Field label="想找什么">
          <Input type="search" value={query} maxLength={200} placeholder="比如：我喜欢吃什么" onChange={(e) => setQuery(e.target.value)} />
        </Field>
        <Button type="submit" busy={busy} disabled={!query.trim()}>搜索</Button>
      </form>
      {error !== null && (
        <Callout tone="bad">搜索没有完成：{errorMessage(error)}。Ombre 连不上时搜不了，先看上面的连接情况。 <Button kind="text" size="sm" onClick={() => void search()}>重试</Button></Callout>
      )}
      {result && (
        result.results.length === 0
          ? result.raw
            ? <pre className="cs-code">{result.raw}</pre>
            : <Empty>没有找到和「{result.query}」有关的记忆，换个说法试试。</Empty>
          : (
            <>
              <p className="cs-muted">找到 {result.resultCount} 条和「{result.query}」有关的记忆</p>
              <div className="cs-list">
                {result.results.map((item, index) => (
                  <div className="cs-list-item mem-item" key={`${index}-${String(item.bucketId ?? '')}`}>
                    <p className="mem-text mem-raw">{searchText(item.raw)}</p>
                    <span className="mem-meta">
                      {typeof item.score === 'number' && <span>相关度 {item.score.toFixed(2)}</span>}
                      {item.known === true && <Tag tone="ok">她已经知道</Tag>}
                      {typeof item.bucketId === 'string' && item.bucketId && <span className="mem-id">编号 {item.bucketId}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )
      )}
    </Section>
  );
}

function OmbreCatalog() {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'unsupported' | 'error'>('idle');
  const [catalog, setCatalog] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    setState('loading');
    try {
      setCatalog(await adminApi.ombreCatalog(50));
      setState('ready');
    } catch (e) {
      setError(e);
      setState(e instanceof ApiError && e.status === 409 ? 'unsupported' : 'error');
    }
  };

  return (
    <Section title="记忆目录" desc="Ombre 里记忆的分类清单，需要 Ombre 版本支持。">
      <div className="cs-actions">
        <Button kind="quiet" busy={state === 'loading'} onClick={() => void load()}>{state === 'ready' ? '重新读取目录' : '读取记忆目录'}</Button>
      </div>
      {state === 'unsupported' && <Callout>当前的 Ombre 版本没有提供目录功能，升级 Ombre 后才能在这里查看。</Callout>}
      {state === 'error' && <Callout tone="bad">目录没有读出来：{errorMessage(error)}。Ombre 连不上时读不了，先看上面的连接情况。</Callout>}
      {state === 'ready' && catalog && <CatalogView catalog={catalog} />}
    </Section>
  );
}

function catalogItemTitle(item: unknown): { title: string; body?: string; meta?: string } {
  if (item === null || typeof item !== 'object') return { title: String(item) };
  const o = item as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => o[k]).find((v) => typeof v === 'string' || typeof v === 'number');
  const title = pick('name', 'title', 'label', 'bucket', 'bucket_id', 'bucketId', 'id');
  const body = pick('description', 'summary', 'content', 'preview');
  const count = pick('count', 'size', 'total');
  return { title: title !== undefined ? String(title) : JSON.stringify(o), body: body !== undefined ? String(body) : undefined, meta: count !== undefined ? `${count} 条` : undefined };
}

function CatalogView({ catalog }: { catalog: Record<string, unknown> }) {
  const listKey = ['catalog', 'items', 'buckets', 'entries', 'results'].find((k) => Array.isArray(catalog[k]))
    ?? Object.keys(catalog).find((k) => Array.isArray(catalog[k]));
  const items = listKey ? catalog[listKey] as unknown[] : null;
  if (!items) {
    const raw = typeof catalog.raw === 'string' ? catalog.raw : JSON.stringify(catalog, null, 2);
    return raw.trim() ? <pre className="cs-code">{raw}</pre> : <Empty>目录是空的。</Empty>;
  }
  return (
    <>
      {items.length === 0 ? <Empty>目录是空的，Ombre 里还没有记忆。</Empty> : (
        <div className="cs-list">
          {items.slice(0, 200).map((item, index) => {
            const { title, body, meta } = catalogItemTitle(item);
            return (
              <div className="cs-list-item" key={`${index}-${title}`}>
                <span className="cs-list-title">{title}</span>
                {meta && <span className="cs-list-meta">{meta}</span>}
                {body && <span className="cs-list-body mem-text">{body}</span>}
              </div>
            );
          })}
        </div>
      )}
      <details className="mem-raw-details">
        <summary>查看原始数据</summary>
        <pre className="cs-code">{JSON.stringify(catalog, null, 2)}</pre>
      </details>
    </>
  );
}

function ActivityList({ items, loading, onReload }: { items: AdminActivityItem[]; loading: boolean; onReload: () => void }) {
  const [shown, setShown] = useState(15);
  return (
    <>
      <div className="cs-actions mem-status-line">
        <span className="cs-muted">{items.length ? `最近 ${items.length} 条` : ''}</span>
        <Button kind="text" size="sm" busy={loading} onClick={onReload}>刷新</Button>
      </div>
      {items.length === 0 ? <Empty>还没有活动记录。</Empty> : (
        <div className="cs-list">
          {items.slice(0, shown).map((item) => {
            const detail = activityDetail(item.detail ?? {});
            const tone = activityTone(item.type);
            return (
              <div className="cs-list-item" key={item.id}>
                <span>{tone ? <Status tone="bad">{ACTIVITY_LABELS[item.type] ?? item.type}</Status> : ACTIVITY_LABELS[item.type] ?? item.type}</span>
                <span className="cs-list-meta" title={fmtTime(item.createdAt, true)}>{fmtAgo(item.createdAt)}</span>
                {detail && <span className="cs-list-body">{detail}</span>}
              </div>
            );
          })}
        </div>
      )}
      {items.length > shown && (
        <div className="cs-actions" data-no-dirty>
          <Button kind="quiet" size="sm" onClick={() => setShown((n) => n + 15)}>再显示 {Math.min(15, items.length - shown)} 条</Button>
        </div>
      )}
    </>
  );
}
