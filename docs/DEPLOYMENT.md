# SOOYA 部署文档

目标环境：**2 核 2 GB 的 Linux 服务器**，单进程，无外部依赖服务。

- [部署方式对比](#部署方式对比)
- [方式一：Linux 原生部署（推荐）](#方式一linux-原生部署推荐)
- [方式二：Docker Compose](#方式二docker-compose)
- [Nginx 反向代理与 TLS](#nginx-反向代理与-tls)
- [升级](#升级)
- [回滚](#回滚)
- [备份与恢复](#备份与恢复)
- [监控与健康检查](#监控与健康检查)
- [安全清单](#安全清单)
- [故障排查](#故障排查)

---

## 部署方式对比

| | Linux 原生 | Docker |
| --- | --- | --- |
| 内存占用 | 更低（约 90–150 MB） | 略高 |
| 升级 / 回滚 | `upgrade.sh` / `rollback.sh`，秒级切换 | 重建镜像 |
| 隔离性 | systemd 加固 | 容器隔离 |
| 适合 | 2 GB 小机器 | 已有 Docker 工作流 |

两种方式的用户数据都放在**独立于代码的目录**，升级不会覆盖。

---

## 方式一：Linux 原生部署（推荐）

### 1. 准备环境

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# better-sqlite3 需要从源码编译
sudo apt-get install -y python3 make g++ git curl
node -v   # 必须 >= 20.10
```

### 2. 安装

```bash
git clone <your-repo> /tmp/sooya-src && cd /tmp/sooya-src
sudo ./deploy/install.sh
```

脚本会：创建 `sooya` 系统用户 → 把源码复制到 `/opt/sooya/releases/<时间戳>/` →
`npm ci` 并编译 → 构建前后端 → 生成 `/opt/sooya/shared/.env`（含随机管理令牌，权限 600）→
建立 `current` 符号链接 → 安装并启动 systemd 服务 → 探测 `/health/ready`。

**目录结构：**

```
/opt/sooya/
├── releases/
│   ├── 20260728065457/        旧版本（保留最近 5 个，回滚用）
│   └── 20260728071230/        当前版本
├── current -> releases/20260728071230
├── CURRENT_RELEASE
└── shared/                    ★ 用户数据，升级永不覆盖
    ├── .env                   密钥（600）
    ├── config/                persona.json, models.json
    └── data/
        ├── database/          SQLite
        ├── media/             图片、语音、表情、文件
        ├── backups/
        └── logs/
```

### 3. 配置

安装脚本生成管理令牌后，打开 `/admin/models`（管理后台 → 模型配置）配置所有模型和联网搜索。联网搜索作为现有能力列表的一项，支持豆包 Custom/Global、Tavily 与 Responses 的自由启用和排序回退。模型与搜索密钥由页面安全提交，GET 接口和页面都不会拿到明文。

唯一持久化文件为 `/opt/sooya/shared/config/models.json`。运维可以直接编辑它；合法配置会自动热加载，非法配置保留上一次有效运行状态。旧版 `.env` 中的模型和搜索变量只在首次升级到 `storageVersion: 2` 时迁移一次，之后不再参与运行时覆盖。

`responses` 仅在 chat 使用 `openai-responses` 且模型配置声明 `supportsTools=true` 时可用。`.env` 继续保留端口、目录、代理、管理令牌和聊天访问令牌等部署参数。

```bash
curl -fsS http://127.0.0.1:8788/health/ready
curl -fsS http://127.0.0.1:8788/api/capabilities | jq .capabilities
```

### 4. 服务管理

```bash
sudo systemctl status sooya
sudo systemctl restart sooya
sudo journalctl -u sooya -f
sudo journalctl -u sooya --since "1 hour ago" -p warning
```

systemd 单元已启用加固：`NoNewPrivileges`、`ProtectSystem=strict`、`PrivateTmp`、
`ProtectHome`、仅 `/opt/sooya/shared` 可写、`MemoryMax=1200M`、`CPUQuota=180%`。
停止时发送 `SIGTERM`，应用会优雅关闭（等待进行中的任务、checkpoint WAL 后再退出）。

---

## 方式二：Docker Compose

```bash
git clone <your-repo> sooya && cd sooya
cp .env.example .env && chmod 600 .env
nano .env

docker compose up -d --build
docker compose logs -f
curl -fsS http://127.0.0.1:8788/health/ready
```

- 端口只绑定 `127.0.0.1`，公网访问请走 Nginx。
- `./data` 与 `./config` 是宿主机挂载卷，`docker compose down` 或重建镜像都不会丢。
- 容器以非 root 用户 `sooya`(1001) 运行，内置 `HEALTHCHECK` 探测 `/health/ready`。

升级：

```bash
git pull
docker compose up -d --build     # 数据卷不受影响
```

---

## Nginx 反向代理与 TLS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/sooya
sudo nano /etc/nginx/sites-available/sooya          # 改 server_name 与证书路径
sudo ln -s /etc/nginx/sites-available/sooya /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d sooya.example.com
```

**三个必须注意的点：**

1. **`/api/stream` 必须关闭缓冲**（配置示例里已有 `proxy_buffering off` 和
   `proxy_read_timeout 1h`）。开着缓冲会导致 SSE 事件被攒住，表现为「回复不出现，
   刷新才看到」。
2. **`client_max_body_size` 要 ≥ `MAX_UPLOAD_BYTES`**（默认 25 MB，配置里写 26m）。
3. **`/health/` 限制为仅本机可访问**，配置示例已包含 `allow 127.0.0.1; deny all;`。

---

## 升级

```bash
cd /path/to/new-source
sudo ./deploy/upgrade.sh --source .
```

执行顺序：

1. **先备份**（优先调用管理 API 做在线校验备份，否则做 WAL 安全的文件复制）；
2. 在新的 `releases/<时间戳>/` 里安装依赖并构建；
3. 原子切换 `current` 符号链接并重启服务；
4. 探测 `/health/ready`（最多 45 秒）；
5. **失败则自动回滚到上一个版本**并重启；
6. 校验 `.env`、`config/`、`data/` 依然存在，缺失则报错退出；
7. 清理超出保留数量的旧版本（默认保留 5 个）。

**升级保证保留：** `.env`、`config/`（含自定义人格与模型配置）、`data/`（数据库、
媒体、备份、日志）。这些都在 `shared/` 里，`upgrade.sh` 从不写入该目录中的这些路径。

> 部署脚本探测的是 `/health/ready`，该端点**不受 `WEB_CHAT_TOKEN` 保护**，
> 所以设置了聊天令牌也不会造成部署误判失败。

---

## 自动更新（跟随 `main`）

`upgrade.sh` 已经承担了所有危险动作，所以自动更新只是一层判断"要不要升级"的外壳：
比对 `origin/main` 与已部署的 commit，不同才动手。

```bash
# 一次性：把本机变成跟随 main 的部署机
sudo git clone https://github.com/<你>/sooya.git /opt/sooya/src
sudo cp /opt/sooya/src/deploy/sooya-auto-update.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sooya-auto-update.timer
```

```bash
sudo systemctl list-timers sooya-auto-update      # 下次何时检查
sudo journalctl -u sooya-auto-update -f           # 看它做了什么
sudo /opt/sooya/src/deploy/auto-update.sh --dir /opt/sooya --branch main   # 立刻手动跑一次
```

默认每 5 分钟检查一次（开机 3 分钟后先跑一次），并带 ±60 秒随机抖动。

**它的行为边界：**

- `main` 没动 → 直接退出，**不重启服务**，所以定时器跑得再频繁也不影响运行中的实例；
- `flock` 保证不会有两次升级重叠 —— 定时器在上一次还没升完时触发会安静退出；
- `git fetch` 失败 → 退出，运行中的版本不受影响；
- `--require-green`（service 单元里默认开启）会先查这个 commit 在 GitHub 上的
  检查结果，**不绿不部署**，读不到状态也不部署（fail closed）。私有仓库需要在
  service 单元里设 `Environment=GITHUB_TOKEN=...`，否则查不到就永远不部署；
- 已部署的 commit 记录在 `shared/.deployed-commit`，且**只在 `upgrade.sh` 成功返回后
  才写入**。升级失败时 `upgrade.sh` 已经把旧版本恢复回去了，而记录没变，所以下次会
  重试同一个 commit，而不是把失败当成已上线。

**要不要用它，取决于你怎么看待"自动"：** 好处是推到 `main` 五分钟内自动上线；
代价是一次坏合并也会在五分钟内自动上线（虽然健康检查失败会自动回滚）。
想更保守就把定时器停掉，只在需要时手动跑那条 `auto-update.sh` 命令 —— 脚本本身
是幂等的，手动跑和定时跑没有区别。

---

## 回滚

```bash
sudo ./deploy/rollback.sh --list      # 查看可用版本，* 是当前
sudo ./deploy/rollback.sh             # 回到上一个版本
sudo ./deploy/rollback.sh --to 20260728065457
```

**回滚只回滚代码**，不动数据库和媒体，所以不会丢聊天记录。
如果确实需要把数据也退回，回滚后再恢复对应时间点的备份。

---

## 备份与恢复

### 自动备份

应用内置定时备份，由 `BACKUP_INTERVAL_MS`（默认 6 小时）和 `BACKUP_KEEP`（默认 7 份）控制，
使用 SQLite 在线备份 API，每份都经过 `integrity_check` 验证，并生成 `.sha256` 与 `.json` 清单。

### 完整备份（数据库 + 媒体 + 配置）

```bash
sudo ./deploy/backup.sh --keep 14
# 产出：/opt/sooya/shared/data/backups/sooya-backup-<时间戳>.tar.gz (+ .sha256)
```

加入 cron，每天凌晨 3 点：

```cron
0 3 * * * /opt/sooya/current/deploy/backup.sh --dir /opt/sooya --keep 14 >> /var/log/sooya-backup.log 2>&1
```

默认**不打包 `.env`**（内含密钥）。需要时：`INCLUDE_ENV=1 ./deploy/backup.sh`，
并确保归档本身被妥善保护。

### 恢复

```bash
sudo ./deploy/restore-backup.sh --file /opt/sooya/shared/data/backups/sooya-backup-20260728T063804Z.tar.gz
```

流程：校验 sha256 → 停止服务 → 把现有数据留存到 `data/pre-restore-<时间戳>/` →
恢复数据库、媒体、配置 → 启动服务 → 探测健康。

### 通过管理 API 备份

```bash
ADMIN=$(sudo grep ^ADMIN_API_TOKEN= /opt/sooya/shared/.env | cut -d= -f2-)

curl -X POST -H "x-admin-token: $ADMIN" http://127.0.0.1:8788/api/admin/backups
curl -H "x-admin-token: $ADMIN" http://127.0.0.1:8788/api/admin/backups
curl -X POST -H "x-admin-token: $ADMIN" http://127.0.0.1:8788/api/admin/backups/<name>/verify
curl -X POST -H "x-admin-token: $ADMIN" http://127.0.0.1:8788/api/admin/backups/<name>/restore
```

### 定期演练

建议每季度做一次恢复演练：把最新归档恢复到一台测试机，确认聊天记录、
媒体和人格设置都在。

---

## 监控与健康检查

| 端点 | 用途 |
| --- | --- |
| `/health/live` | 进程存活（liveness） |
| `/health/ready` | 可服务流量（readiness） |
| `/health/deep` | 含数据库 `integrity_check` |
| `/api/capabilities` | 各模型能力是否已配置 |
| `/api/admin/system` | 内存、存储、数据库统计、SSE 订阅数 |
| `/api/admin/errors` | 最近错误（已脱敏） |

简易巡检脚本：

```bash
#!/usr/bin/env bash
if ! curl -fsS --max-time 10 http://127.0.0.1:8788/health/ready >/dev/null; then
  echo "SOOYA unhealthy, restarting" | logger -t sooya-watchdog
  systemctl restart sooya
fi
```

日志：`journalctl -u sooya`，以及 `data/logs/app.log` 与 `data/logs/error.log`。
密钥在写入日志前已脱敏。

---

## 安全清单

公网上线前逐条确认：

- [ ] `WEB_CHAT_TOKEN` 已设置为 32 字节以上随机串
- [ ] `ADMIN_API_TOKEN` 已设置且与聊天令牌不同
- [ ] `.env` 权限为 `600` 且属主是服务用户
- [ ] Nginx 已启用 TLS，HTTP 全量跳转 HTTPS
- [ ] `/health/` 仅允许本机访问
- [ ] `client_max_body_size` 与 `MAX_UPLOAD_BYTES` 匹配
- [ ] `ALLOW_PRIVATE_NETWORK_FETCH=false`（除非模型服务在本机）
- [ ] 防火墙只放行 80/443，8788 不直接暴露
- [ ] 备份 cron 已配置并验证过至少一次恢复
- [ ] 已确认 `/api/admin/models` 返回的是 `apiKeyConfigured` 而不是明文密钥

内置的防护：请求体与上传大小限制、上传类型白名单 + 内容嗅探（不信任声明的 MIME）、
路径穿越防护（含 URL 编码与符号链接逃逸）、SSRF 防护（阻断私网地址、`file://`、
每跳重定向都校验）、下载超时与大小上限、日志与错误表密钥脱敏、常数时间令牌比较。

---

## 故障排查

**服务起不来**

```bash
sudo journalctl -u sooya -n 100 --no-pager
sudo -u sooya node /opt/sooya/current/packages/server/dist/main.js   # 前台看报错
```

**`better-sqlite3` 报错 / 段错误**

```bash
cd /opt/sooya/current
sudo -u sooya npm rebuild better-sqlite3 --build-from-source
```

本项目锁定 `better-sqlite3@^12`。13.x 在部分环境下加载后即段错误，如果你手动升级过，
请退回 12.x。

**回复不出现，刷新才看到**

九成是反向代理缓冲了 SSE。检查 `/api/stream` 的 `proxy_buffering off`。
验证方法：

```bash
curl -N -H "x-sooya-token: $TOKEN" http://127.0.0.1:8788/api/stream   # 应立刻输出 stream.ready
```

即使 SSE 完全不通，前端也会在切回标签页时通过 REST 对账补齐，不会永久丢失消息。

**SOOYA 不发语音 / 图片**

```bash
curl -s http://127.0.0.1:8788/api/capabilities | jq '.capabilities.tts, .capabilities.image'
```

`configured: false` 说明模型没配。注意 `configured: true` 只代表配置齐全，
不代表第三方 API 真的可用——真实可用性要用真实密钥调一次才知道。

**数据库损坏**

启动时会自动隔离并从最近的有效备份恢复，`/health/ready` 的 `dbRecovered` 会变成 `true`。
损坏文件保留为 `sooya.db.corrupt-<时间戳>`。手动检查：

```bash
sqlite3 /opt/sooya/shared/data/database/sooya.db "PRAGMA integrity_check;"
```

**磁盘占满**

```bash
du -sh /opt/sooya/shared/data/*
ADMIN=$(sudo grep ^ADMIN_API_TOKEN= /opt/sooya/shared/.env | cut -d= -f2-)
curl -s -H "x-admin-token: $ADMIN" http://127.0.0.1:8788/api/admin/media | jq .total
```

调小 `BACKUP_KEEP`，或通过 `DELETE /api/admin/media/:id` 清理旧媒体。

**内存吃紧（2 GB 机器）**

正常常驻约 90–150 MB。可下调 `CONTEXT_RECENT_MESSAGES`、`maxTokens`，
或在 systemd 单元里收紧 `MemoryMax`。
