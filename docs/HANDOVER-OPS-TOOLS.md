# 交接：联网工具 `http_request` 与服务器运维工具

> 状态截至 2026-10-20 04:15（服务器时间）。工作**暂停**，没有上线。
> 分支 `claude/new-session-5jb950`，PR [#170](https://github.com/sooya7/sooya/pull/170)（未合并）。
> 原始需求见用户提供的《SOOYA 联网与运维工具 · 实施方案》，本文只记录实际做到哪一步。

---

## 1. 一句话现状

- **代码**：全部写完，本地和 CI 都在跑绿（交接时 9 项 CI 已有 7 项通过，剩 e2e 和 release smoke 还在跑）。**没合并，没部署**，线上的 SOOYA 还是旧版本，行为不变。
- **服务器**：`server.py` 已经加上三个新工具并生效。**SOOYA 的 `mcp.json` 和 `.env` 都还没改**。
- **⚠️ 遗留故障**：`srv-mcp-bridge` 目前**卡死**，所有 srv 工具调用都超时，需要有人 SSH 执行一次 `systemctl restart srv-mcp-bridge`（原因见 §4）。

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

## 4. 遗留故障：srv-bridge 的通知死锁

`/opt/mcp-gateway/srv-bridge.py` 处理 POST 时，对没有 `id` 的消息（通知）也调用 `_rpc()`，会在 `stdout.readline()` 上一直等回包。MCP 的通知按规范没有回包，所以 bridge 会**永远占着全局 `_lock`**，后面所有请求都会挂住，只能重启 bridge。

- 触发：交接前我用 SDK 的 streamable-http 客户端探测兼容性，客户端连接时发出了 `notifications/initialized`。
- 影响：所有经过 srv-bridge 的工具（包括网页端 Claude 等其他 Agent 用的）都超时。
- **恢复**：`systemctl restart srv-mcp-bridge`。
- **对 SOOYA 的意义**：正因为这个 bug，SOOYA 连 srv **必须**用 `"transport": "post-jsonrpc"`，不能用默认的 streamable-http（SDK 连接时会发 initialized，中断请求时会发 cancelled，都会把 bridge 卡死）。
- 根治建议（等用户决定，**还没做**）：bridge 收到通知时只写给子进程，不再 `readline`。这只是修 bug，不改协议。

另一个小坑：在 srv 的 `run_command` 里**不要**再去 curl 这个 bridge 自己的 `/mcp`，会自己等自己（要等 60 秒命令超时才会解开）。查 `/health`（GET）没问题，它不走锁。

---

## 5. 继续做的步骤（顺序不能反）

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

## 6. 待用户拍板

1. `secret_read` 要不要从 reply 阶段关掉（原方案 §2.5）？关掉以后 `http_request` 照样能用：宿主直接调 handler，不看 phases，只要这个工具还注册着就行。所以改 `phases` 即可，**不要**把它从 toolPolicy 里删掉。删掉也能用，只是会退回默认策略。
2. 用户发 Key 的那条 QQ 消息要不要在本地聊天记录里打码（原方案 §2.6）？
3. 要不要修 srv-bridge 的通知死锁（§4）？
