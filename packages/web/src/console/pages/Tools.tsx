import { useMemo, useState } from 'react';
import { adminApi, type AdminMcpOverview, type AdminMcpServer, type AdminMcpTool } from '../../lib/admin.js';
import {
  Button, Callout, Empty, Facts, Input, Loadable, Loading, Page, Section, Status, Tag, errorMessage, fmtAgo, useAction, useConsole, useLoad,
  type Tone
} from '../ui.js';

/*
 * 工具页：她能调用的外部 MCP 服务。服务端给的 URL 已去掉查询参数和片段，
 * 认证只给“是否已配置”，这里也只显示这些。
 */

const SERVER_STATE: Record<string, [string, Tone]> = {
  ready: ['已连接', 'ok'],
  connecting: ['正在连接', 'warn'],
  degraded: ['连接有问题', 'bad'],
  closed: ['没有连接', 'off'],
  disabled: ['已停用', 'off']
};

const RISK: Record<string, [string, 'ok' | 'warn' | 'bad' | undefined]> = {
  read: ['只读', 'ok'],
  write: ['会写入', 'warn'],
  maintenance: ['维护操作', 'warn'],
  external_side_effect: ['会对外产生影响', 'bad'],
  destructive: ['可能删除数据', 'bad']
};

const PHASES: Record<string, string> = {
  reply: '回复你时',
  memory_commit: '写入记忆时',
  proactive: '主动找你时',
  maintenance: '后台维护时',
  admin: '在管理后台里'
};

const POLICY: Array<[string, string]> = [
  ['readEnabled', '允许只读工具'],
  ['writeEnabled', '允许会写入的工具'],
  ['maintenanceEnabled', '允许维护工具']
];

function stateOf(server: AdminMcpServer): [string, Tone] {
  return SERVER_STATE[server.state] ?? [server.state, 'warn'];
}

type ToolDetail = AdminMcpTool & { inputSchema: Record<string, unknown> };

interface Param { name: string; type: string; required: boolean; description: string; extra: string }

function schemaType(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return `可选值：${schema.enum.map(String).join('、')}`;
  const type = schema.type;
  if (Array.isArray(type)) return type.join(' 或 ');
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    return items && typeof items.type === 'string' ? `${items.type} 列表` : '列表';
  }
  return typeof type === 'string' ? type : schema.anyOf || schema.oneOf ? '多种类型' : '任意';
}

function schemaParams(schema: Record<string, unknown>): Param[] {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(props).map(([name, prop]) => {
    const extra: string[] = [];
    if (prop.default !== undefined) extra.push(`默认 ${JSON.stringify(prop.default)}`);
    if (typeof prop.minimum === 'number') extra.push(`最小 ${prop.minimum}`);
    if (typeof prop.maximum === 'number') extra.push(`最大 ${prop.maximum}`);
    if (typeof prop.maxLength === 'number') extra.push(`最多 ${prop.maxLength} 字`);
    return {
      name,
      type: schemaType(prop ?? {}),
      required: required.has(name),
      description: typeof prop?.description === 'string' ? prop.description : '',
      extra: extra.join('，')
    };
  });
}

function ServerRow({ server, onUpdated, onFailed }: {
  server: AdminMcpServer; onUpdated: (next: AdminMcpServer, refreshed: boolean) => void; onFailed: () => void;
}) {
  const { run, busy } = useAction();
  const { notify } = useConsole();
  const [label, tone] = stateOf(server);
  const connected = server.lastConnectedAt ?? server.lastConnected;
  const refreshed = server.lastRefreshAt ?? server.lastRefresh;

  const test = async () => {
    const res = await run('test', () => adminApi.testMcpServer(server.id));
    if (!res) { onFailed(); return; }
    onUpdated(res.server, false);
    if (res.ok) notify(`${server.id} 连接正常${res.server.latencyMs !== undefined ? `，耗时 ${res.server.latencyMs} 毫秒` : ''}`, 'ok');
    else notify(`${server.id} 没有连上${res.server.lastError ? `：${res.server.lastError}` : ''}`, 'bad');
  };
  const refresh = async () => {
    const res = await run('refresh', () => adminApi.refreshMcpTools(server.id));
    // The failure toast is generic; reload so the row shows the server's latest error.
    if (!res) { onFailed(); return; }
    onUpdated(res.server, true);
    notify(`${server.id} 的工具列表已刷新，现在有 ${res.server.toolCount} 个工具`, 'ok');
  };

  return (
    <div className="cs-list-item">
      <span>
        <span className="cs-list-title">{server.id}</span>{' '}
        {server.required && <Tag tone="warn">必需</Tag>}
      </span>
      <span className="cs-list-side"><Status tone={tone}>{label}</Status></span>
      <span className="cs-list-body">
        <span style={{ overflowWrap: 'anywhere' }}>{server.url || '没有可显示的地址'}</span>
        <span className="cs-list-meta" style={{ display: 'block' }}>
          {[
            server.transport,
            `${server.toolCount} 个工具`,
            server.authConfigured ? '已配置认证' : '没有配置认证',
            server.latencyMs !== undefined ? `上次耗时 ${server.latencyMs} 毫秒` : null,
            connected ? `上次连上 ${fmtAgo(connected)}` : '还没有连上过',
            refreshed ? `工具列表刷新于 ${fmtAgo(refreshed)}` : null
          ].filter(Boolean).join('，')}
        </span>
      </span>
      {server.lastError && <span className="cs-list-body"><Callout tone="bad">最近的错误：{server.lastError}</Callout></span>}
      <span className="cs-list-body">
        <span className="cs-actions">
          {server.enabled ? (
            <>
              <Button kind="quiet" size="sm" busy={busy === 'test'} disabled={!!busy} onClick={() => void test()}>测试连接</Button>
              <Button kind="quiet" size="sm" busy={busy === 'refresh'} disabled={!!busy} onClick={() => void refresh()}>刷新工具列表</Button>
            </>
          ) : (
            <span className="cs-muted">这个服务在配置文件里停用了，要用它先在配置里把 enabled 改成 true，再重启服务。</span>
          )}
        </span>
      </span>
    </div>
  );
}

function ToolDetailView({ listed }: { listed: AdminMcpTool }) {
  const name = listed.name;
  // The schema endpoint omits server/remote names; keep them from the list row.
  const detail = useLoad(() => adminApi.mcpToolSchema(name).then((r) => ({ ...listed, ...r.tool }) as ToolDetail), [name]);
  const [raw, setRaw] = useState(false);
  if (detail.loading && !detail.data) return <Loading>正在读取工具参数…</Loading>;
  if (detail.error && !detail.data) {
    return <Callout tone="bad">读不到这个工具的详情：{errorMessage(detail.error)} <Button kind="text" size="sm" onClick={() => void detail.reload()}>重试</Button></Callout>;
  }
  const tool = detail.data!;
  const params = schemaParams(tool.inputSchema ?? {});
  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {tool.description && <p style={{ whiteSpace: 'pre-wrap' }}>{tool.description}</p>}
      <Facts items={[
        ['所属服务', tool.serverId ?? '内置'],
        ['服务端的原名', tool.remoteName ?? tool.name],
        ['模型看到的名字', tool.modelName ?? tool.name],
        ['会在什么时候用', tool.phases.map((p) => PHASES[p] ?? p).join('、') || '—']
      ]} />
      {params.length === 0 ? <p className="cs-muted">这个工具不需要参数。</p> : (
        <div className="cs-table-wrap">
          <table className="cs-table">
            <thead><tr><th>参数</th><th>类型</th><th>必填</th><th>说明</th></tr></thead>
            <tbody>
              {params.map((p) => (
                <tr key={p.name}>
                  <td className="cs-nowrap"><code>{p.name}</code></td>
                  <td>{p.type}</td>
                  <td className="cs-nowrap">{p.required ? '必填' : '可不填'}</td>
                  <td>{p.description || <span className="cs-muted">—</span>}{p.extra && <div className="cs-muted">{p.extra}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="cs-actions">
        <Button kind="text" size="sm" onClick={() => setRaw((v) => !v)}>{raw ? '收起原始参数定义' : '查看原始参数定义'}</Button>
      </div>
      {raw && <pre className="cs-code">{JSON.stringify(tool.inputSchema, null, 2)}</pre>}
    </div>
  );
}

function ToolList({ tools }: { tools: AdminMcpTool[] }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((t) => [t.name, t.serverId, t.description].some((v) => v?.toLowerCase().includes(q)));
  }, [tools, query]);
  const unauthorized = tools.filter((t) => !t.authorized).length;

  if (tools.length === 0) {
    return <Empty>还没有发现任何工具。先确认上面的服务已连接，再点“刷新工具列表”。</Empty>;
  }
  return (
    <>
      <p className="cs-muted">
        共 {tools.length} 个工具{unauthorized ? `，其中 ${unauthorized} 个因为权限设置暂时不能用` : ''}。
      </p>
      {tools.length > 6 && (
        <Input type="search" aria-label="搜索工具" placeholder="按名字、服务或说明搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      {filtered.length === 0 ? <Empty>没有匹配“{query}”的工具。</Empty> : (
        <div className="cs-list">
          {filtered.map((tool) => {
            const [risk, tone] = RISK[tool.risk] ?? [tool.risk, undefined];
            const isOpen = open === tool.name;
            return (
              <div className="cs-list-item" key={tool.name}>
                <span className="cs-list-title"><code>{tool.name}</code></span>
                <span className="cs-list-side">
                  <Tag tone={tone}>{risk}</Tag>
                  {!tool.authorized && <Tag>未授权</Tag>}
                </span>
                <span className="cs-list-body">
                  {tool.description ? tool.description.split('\n')[0] : <span className="cs-muted">没有说明</span>}
                  <span className="cs-list-meta" style={{ display: 'block' }}>{tool.serverId ?? '内置'}</span>
                </span>
                <span className="cs-list-body">
                  <Button kind="text" size="sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : tool.name)}>
                    {isOpen ? '收起参数' : '查看参数'}
                  </Button>
                </span>
                {isOpen && <span className="cs-list-body"><ToolDetailView listed={tool} /></span>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function lastCommitTime(commit: Record<string, unknown> | null): string {
  if (!commit) return '还没有过';
  const at = commit.completed_at ?? commit.started_at;
  return typeof at === 'string' ? fmtAgo(at) : '—';
}

export default function Tools() {
  const overview = useLoad(() => adminApi.mcpOverview() as Promise<AdminMcpOverview>);

  const onUpdated = (next: AdminMcpServer, refreshed: boolean) => {
    overview.setData((old) => old ? { ...old, servers: old.servers.map((s) => s.id === next.id ? next : s) } : old);
    // A refresh changes which tools exist; pull the whole overview again so the list matches.
    if (refreshed) void overview.reload();
  };

  return (
    <Page
      title="工具"
      register="system"
      intro="她能调用的外部服务（MCP）。平时只需要看它们连没连上；排查问题时再看具体工具和参数。"
      actions={<Button kind="quiet" size="sm" busy={overview.loading} onClick={() => void overview.reload()}>刷新状态</Button>}
    >
      <Section title="服务" desc="每个服务提供一组工具。地址里的参数已隐藏，认证只显示有没有配置。">
        <Loadable state={overview} label="工具服务">
          {(data) => data.servers.length === 0 ? (
            <Empty>还没有配置任何 MCP 服务。在服务器的 MCP 配置文件里添加后重启服务，这里就会出现。</Empty>
          ) : (
            <div className="cs-list">
              {data.servers.map((server) => <ServerRow key={server.id} server={server} onUpdated={onUpdated} onFailed={() => void overview.reload()} />)}
            </div>
          )}
        </Loadable>
      </Section>

      <Section title="工具" desc="点“查看参数”能看到工具要求的输入。标着会对外产生影响的工具要格外留意。">
        <Loadable state={overview} label="工具列表">{(data) => <ToolList tools={data.tools} />}</Loadable>
      </Section>

      <Section title="权限与来源" desc="哪些类型的工具允许她用。这些开关在服务器配置里改。">
        <Loadable state={overview} label="工具权限">
          {(data) => (
            <>
              <div className="cs-list">
                {POLICY.map(([key, label]) => (
                  <div className="cs-list-item" key={key}>
                    <span>{label}</span>
                    <span className="cs-list-side"><Status tone={data.globalPolicy[key] ? 'ok' : 'off'}>{data.globalPolicy[key] ? '允许' : '不允许'}</Status></span>
                  </div>
                ))}
              </div>
              <p className="cs-muted" style={{ overflowWrap: 'anywhere' }}>配置文件：{data.configSource}</p>
            </>
          )}
        </Loadable>
      </Section>

      <Section title="记忆服务" desc="她的长期记忆也通过 MCP 连接的 Ombre 服务读写。">
        <Loadable state={overview} label="记忆服务">
          {({ memory, dashboardUrl }) => (
            <>
              <Status tone={memory.connection === 'connected' ? 'ok' : 'bad'}>
                {memory.connection === 'connected' ? 'Ombre 已连接' : 'Ombre 连接有问题'}
              </Status>
              {memory.connection !== 'connected' && typeof memory.health?.lastError === 'string' && (
                <Callout tone="bad">原因：{memory.health.lastError}</Callout>
              )}
              <Facts items={[
                ['等待写入的记忆', `${memory.pending} 条`],
                ['写入结果不确定', `${memory.uncertain} 条`],
                ['上次整理记忆', memory.lastDream ? fmtAgo(memory.lastDream) : '还没有过'],
                ['上次写入', lastCommitTime(memory.lastCommit)]
              ]} />
              {(memory.dashboardUrl ?? dashboardUrl) && (
                <p><a href={(memory.dashboardUrl ?? dashboardUrl)!} target="_blank" rel="noreferrer">打开 Ombre 管理页</a></p>
              )}
            </>
          )}
        </Loadable>
      </Section>
    </Page>
  );
}
