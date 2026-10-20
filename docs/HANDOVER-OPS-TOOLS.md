# 交接：联网工具 `http_request` 与服务器运维工具

> 最新决定：2026-10-21（Asia/Shanghai），**项目已弃用；完成仓库收尾后只读归档，不再安排上线或持续运行**。
> PR [#170](https://github.com/sooya7/sooya/pull/170) 已合并，功能提交 `59a8866f769d4779b84af751df8ec7d69630aad7`。
> 原始需求见用户提供的《SOOYA 联网与运维工具 · 实施方案》，本文只记录实际做到哪一步。

---

## 1. 归档收尾

- PR #170 的功能改动已合并；本文和 README 记录最终状态，部署与验收细节作为历史证据保留。
- 用户明确归档意图前已经发生的功能部署保留记录；随后停止并禁用 `sooya-auto-update.timer`，避免文档合并再次触发部署。
- 本次额外启动的 Ombre 容器已恢复为停止状态，重启策略恢复为 `no`。其他原有业务服务未停止或重启。
- 原 `backup/huawei2-20261020` 的完整提交快照保留为标签 `archive/huawei2-20261020`，不把旧分支代码合入主分支；归档时分支只保留 `main`。

### 归档前的历史核验（不代表当前运行状态）

- **代码**：合并前、合并后的 9 项 CI 均通过；功能版本已部署至 `/opt/sooya/releases/20261020170707`。
- **配置**：`http_request` 已注册；`srv` 使用 `post-jsonrpc`，发现 39 个工具，reply 明确授权其中 20 个。未列入策略的工具仍不授权。
- **连接**：SOOYA `/health/ready` 返回 200；srv、knowledge、Ombre 均为 ready，分别发现 39、10、14 个工具。
- **记忆服务**：曾恢复原容器并验证 `breath_search`，随后按归档决定恢复停止和 `restart=no`；镜像和持久化卷未变。bridge 通知死锁已于 10 月 20 日修复。

### 本次验收与回滚

- 线上 8 组验收通过：reply 权限；公网直连；代理 API；真实 New API 密钥代填；合成响应密钥脱敏；文件原文读取/编辑/覆盖及备份和权限保留；命令审计、100 秒上限和受保护服务拒绝；luker 日志读取与 200 行上限。
- 验收调用已部署的工具执行层并连接真实 MCP/API；响应脱敏使用合成密钥回显。没有额外生成模型回复或发送 QQ 消息，未执行真实容器/服务重启工具。
- `secret_read` 的 phases 已改为 `maintenance`，不再直接提供给 reply；宿主仍可读取指定密钥供 `http_request` 代填。
- 以当前 SOOYA 配置的 6 个凭据值精确检查现有聊天正文/转写，匹配数为 0，未改写聊天。没有实现未来消息自动脱敏，也没有清除历史备份中的凭据。
- 数据库 `quick_check=ok`，保留 35 条消息、46 个内容段、458 条媒体记录；临时验收文件已清理。
- 备份及 JSON 验收报告：`/opt/backups/sooya-ops-finish-20261020T170259Z/`（仅管理员可读）。旧版本保留在 `/opt/sooya/releases/20261019120201`。
- 配置回滚：用备份 `env.before`、`mcp.before.json` 恢复 `.env`、`config/mcp.json` 后重启 SOOYA。备份文件为 0600；恢复时 `.env` 保持 root 0600，`mcp.json` 设置 root 0644，确保服务可读。首次回退时的权限错误曾导致短暂启动失败，现已纠正并验收。
- Ombre 重启策略回滚：`docker update --restart=no sooya-ombre-brain`；无须重建容器或恢复卷。

---

## 2. 代码改动（PR #170）

| 文件 | 改动 |
|---|---|
| `core/links/http-request.ts`（新） | `http_request` 工具。任意方法请求公网地址；`secret` 填密钥库名字，服务器代填（`bearer` / `header:<名>` / `query:<名>`）；返回内容里 Key 原值替换成 `[密钥]`；每跳做内网检查；跨域跳转丢掉鉴权；直连 3 秒内快速失败就改走代理；12 秒超时；最多读 1MB，JSON 截到 16KB，二进制只给类型和大小 |
| `core/files/wiring.ts` | 按开关 `HTTP_REQUEST_TOOL_ENABLED`（默认 true）注册 `http_request`；Key 通过 `knowledge__secret_read` 的 handler 由宿主读取，不经过模型 |
| `core/ops/srv-tools.ts`（新） | 对 MCP server `srv` 的工具套一层：`service_restart/stop/start` 拒绝 `sooya`、`srv-mcp-bridge`、`agent-knowledge`；`run_command` 拒绝针对这几个服务的 restart/stop/kill 和 `pkill node` 之类（正则，防手滑）；`docker_logs` / `journal_logs` / `project_logs` 最多 200 行；`run_command` 超时上限 100 秒；中文工具描述（写明改完要汇报文件、改动和备份位置） |
| `core/ops/wiring.ts`（新） | 每条 `run_command` 以 JSONL 格式追加到 `<DATA_DIR>/logs/ops-commands.log`（线上就是 `/opt/sooya/shared/data/logs/`，按大小轮转，保留当前文件加一个 `.1`），同时写 flow-trace；`http_request` 的审计记录（method / host / 状态码 / 耗时 / secret 名，不记值）写进日志和 flow-trace |
| `mcp/post-client.ts`（新） | 新 transport `post-jsonrpc`：只发请求、从不发通知的极简 MCP 客户端，专门给 srv-bridge 用（原因见 §4） |
| `mcp/config.ts` `types.ts` `tool-bridge.ts` | `transport: "post-jsonrpc"`；toolPolicy 里单个工具可以写 `timeoutMs`（上限 120000） |
| `mcp/manager.ts` | `decorate` 钩子：工具注册前由宿主统一包装 |
| `agent/tool-runtime.ts` | 认工具自带的 `timeoutMs`，全局 15 秒不变 |
| `agent/tool-policy.ts` | 本地工具也可以声明 `allowInReply`，同样受 `writeEnabled` 约束 |
| `app.ts` | 接线，约 +250 字节，在 hotspot 上限以内 |
| 测试 | `test/http-request.test.ts`、`test/srv-tools.test.ts`、`src/mcp/post-client.test.ts`，以及 policy / runtime / config 补充用例。本地服务端 1346 个测试全部通过 |

**合并后的影响**：`http_request` 会立刻出现在她的工具里（默认开）。在 `mcp.json` 加 `srv` 之前，运维工具不会出现。

---

## 3. 服务器上已经改了什么

| 位置 | 内容 | 回滚 |
|---|---|---|
| `/opt/chatgpt-mcp/server.py` | 文件末尾 `if __name__` 之前追加了 `read_file_raw` / `edit_file` / `save_file`（不打码读取；写之前备份成 `<原路径>.bak-sooya-<时间戳>`，保留属主和权限，临时文件 + `os.replace` 写入）。原有工具没动 | `cp /opt/chatgpt-mcp/server.py.bak-edit-file-20261020035916 /opt/chatgpt-mcp/server.py && systemctl restart srv-mcp-bridge` |
| `/opt/chatgpt-mcp/sooya-ops-snippet.py` | 追加进去的那段代码，留作对照 | 可删 |
| `/opt/chatgpt-mcp/sooya-ops-smoke.py` | 离线 stdio 冒烟测试：`venv/bin/python sooya-ops-smoke.py <候选 server.py>`，替换前 25 项全部通过 | 可留 |
| `/opt/chatgpt-mcp/sooya-sdk-probe.mjs`、`.out` | 导致 bridge 卡死的那个探测脚本（§4） | **可删** |

另外：`chatgpt-mcp-tunnel.service` 也会跑这个 `server.py`，下次它重启时也会带上三个新工具（只是新增，不影响原有工具）。

**没改的**：`/opt/sooya/shared/config/mcp.json`、`/opt/sooya/shared/.env`、`srv-bridge.py`。

---

## 4. 已修复故障：srv-bridge 的通知死锁

以下为历史故障说明。2026-10-20 已修复：通知仅转发，不等待响应，返回 HTTP 202；本次连接与工具调用正常。

`/opt/mcp-gateway/srv-bridge.py` 处理 POST 时，对没有 `id` 的消息（通知）也调用 `_rpc()`，会在 `stdout.readline()` 上一直等回包。MCP 的通知按规范没有回包，所以 bridge 会**永远占着全局 `_lock`**，后面所有请求都会挂住，只能重启 bridge。

- 触发：交接前我用 SDK 的 streamable-http 客户端探测兼容性，客户端连接时发出了 `notifications/initialized`。
- 影响：所有经过 srv-bridge 的工具（包括网页端 Claude 等其他 Agent 用的）都超时。
- **恢复**：`systemctl restart srv-mcp-bridge`。
- **当前配置**：SOOYA 保留 `"transport": "post-jsonrpc"`。bridge 已修复，因此“SDK 通知一定导致死锁”不再是当前限制。
- **已实施修复**：bridge 收到通知时只写给子进程，不再 `readline`；原鉴权和工具定义保留。

另一个小坑：在 srv 的 `run_command` 里**不要**再去 curl 这个 bridge 自己的 `/mcp`，会自己等自己（要等 60 秒命令超时才会解开）。查 `/health`（GET）没问题，它不走锁。

---

## 5. 历史上线步骤（本次已完成，无须重复执行）

1. 重启 srv-mcp-bridge，确认 `curl -s http://127.0.0.1:18201/health` 返回 `{"ok": true}`。
2. 等 PR #170 的 CI 全绿 → 合并 → auto-update 计时器（每 5 分钟）自动部署 → 核对 `/opt/sooya/shared/.deployed-commit` 是否为合并后的 commit。
3. **部署完成之后**才改 SOOYA 配置。旧代码不认 `post-jsonrpc`，会退回 streamable-http，又把 bridge 卡死。
   - 备份 `.env`，加一行 `SRV_MCP_TOKEN=<bridge.env 里 SRV_TOKEN 的值>`（别把值打印出来）。
   - 备份 `mcp.json`，在 `servers` 里加：
     ```json
     "srv": {
       "enabled": true,
       "transport": "post-jsonrpc",
       "url": "http://127.0.0.1:18201/mcp",
       "auth": { "type": "bearer-env", "env": "SRV_MCP_TOKEN" },
       "required": false,
       "connectTimeoutMs": 10000,
       "toolTimeoutMs": 120000,
       "toolPolicy": {
         "read_file_raw":   { "risk": "read", "phases": ["reply"], "authorized": true },
         "list_directory":  { "risk": "read", "phases": ["reply"], "authorized": true },
         "search_files":    { "risk": "read", "phases": ["reply"], "authorized": true },
         "file_stat":       { "risk": "read", "phases": ["reply"], "authorized": true },
         "docker_ps":       { "risk": "read", "phases": ["reply"], "authorized": true },
         "docker_inspect":  { "risk": "read", "phases": ["reply"], "authorized": true },
         "docker_logs":     { "risk": "read", "phases": ["reply"], "authorized": true },
         "docker_stats":    { "risk": "read", "phases": ["reply"], "authorized": true },
         "service_status":  { "risk": "read", "phases": ["reply"], "authorized": true },
         "journal_logs":    { "risk": "read", "phases": ["reply"], "authorized": true },
         "project_logs":    { "risk": "read", "phases": ["reply"], "authorized": true },
         "server_status":   { "risk": "read", "phases": ["reply"], "authorized": true },
         "memory_status":   { "risk": "read", "phases": ["reply"], "authorized": true },
         "disk_usage":      { "risk": "read", "phases": ["reply"], "authorized": true },
         "list_ports":      { "risk": "read", "phases": ["reply"], "authorized": true },
         "edit_file":       { "risk": "write", "phases": ["reply"], "authorized": true, "allowInReply": true },
         "save_file":       { "risk": "write", "phases": ["reply"], "authorized": true, "allowInReply": true },
         "docker_restart":  { "risk": "maintenance", "phases": ["reply"], "authorized": true, "allowInReply": true, "timeoutMs": 120000 },
         "service_restart": { "risk": "maintenance", "phases": ["reply"], "authorized": true, "allowInReply": true, "timeoutMs": 120000 },
         "run_command":     { "risk": "maintenance", "phases": ["reply"], "authorized": true, "allowInReply": true, "timeoutMs": 120000 }
       }
     }
     ```
     没列出来的工具（原版 `read_file` / `write_file` / `create_file`、`move_file`、`service_stop`、`docker_compose_*`、git 写操作）按现有机制默认拒绝。`maintenanceEnabled` 现在就是开的（`MCP_MAINTENANCE_ENABLED` 默认 true）。
   - `systemctl restart sooya`，确认 `journalctl -u sooya` 里出现 `mcp.connect_success`（serverId srv），并且 `/health/ready` 返回 200。
4. 按原方案 §4 做服务器实测：`http_request` 国内 API / `proxy=true` 国外 API / 带 secret 调 Fish 或 New API；用含假 Key 的测试文件验证 `edit_file` / `save_file`；`run_command uptime` 之后看 `ops-commands.log` 有没有记录；`systemctl restart sooya` 要被拒绝；`docker_logs luker` 读 50 行。
5. 写进知识库 `01-Projects/SOOYA.md`。

---

## 6. 原待决事项的处理结果

1. 已从 reply 关闭 `secret_read`，保留注册及宿主读取；真实 API 代填验收通过。
2. 已执行当前 SOOYA 凭据的精确检查，没有命中；聊天内容保留。未来消息自动脱敏不在本次实现内。
3. 通知死锁已修复并上线，详见 §4。
