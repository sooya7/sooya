# SOOYA Ombre Brain 部署

这个目录只描述 SOOYA 使用的固定 Ombre 运行边界。Ombre 不作为 SOOYA 源码的未跟踪目录发布，也不跟随 `main` 自动升级。

固定版本：`v2.7.6`，commit `6da5158b70d833626438a6fd5448f839c562d44b`。

## 首次部署

在服务器上执行，路径和密钥文件均不打印：

```bash
sudo install -d -m 0750 /opt/ombre-brain/source /opt/ombre-brain/buckets
sudo git clone --branch v2.7.6 --depth 1 https://github.com/P0luz/Ombre-Brain.git /opt/ombre-brain/source
cd /opt/ombre-brain/source
test "$(git rev-parse HEAD)" = "6da5158b70d833626438a6fd5448f839c562d44b"
sudo install -d -m 0750 /opt/ombre-brain/compose
sudo install -m 0644 deploy/ombre/docker-compose.yml /opt/ombre-brain/compose/docker-compose.yml
sudo cp deploy/ombre/.env.example /opt/ombre-brain/.env
sudo chmod 600 /opt/ombre-brain/.env
```

把压缩模型的 key/base/model、Dashboard 密码和 MCP token 写入 `/opt/ombre-brain/.env`。SOOYA 的 `/opt/sooya/shared/.env` 只保存同一个 MCP token，不把 token 写入 Git 或日志。

启动或升级：

```bash
cd /opt/ombre-brain
sudo OMBRE_SOURCE_DIR=/opt/ombre-brain/source \
  docker compose --env-file /opt/ombre-brain/.env -f /opt/ombre-brain/compose/docker-compose.yml up -d --build
```

`OMBRE_PIP_INDEX_URL` 只在构建阶段用于下载锁定的 Python 依赖，不会注入运行容器。Compose 固定使用 `linux/amd64`；如果 registry mirror 返回多平台 layer descriptor 错误，先执行：

```bash
docker pull --platform=linux/amd64 docker.1ms.run/library/python:3.12-slim
docker tag docker.1ms.run/library/python:3.12-slim python:3.12-slim
```

Compose 只把 `127.0.0.1:18001` 映射到容器的 8000 端口，未复用 SOOYA 的外部代理，也不修改 Cloudflare/Nginx 路由。Dashboard 需要时通过 SSH 本地转发访问：

```bash
ssh -L 18001:127.0.0.1:18001 <server>
```

## 验收与回滚

```bash
curl -fsS http://127.0.0.1:18001/health
docker compose --env-file /opt/ombre-brain/.env -f /opt/ombre-brain/compose/docker-compose.yml ps
```

MCP 验收必须使用 Bearer token 调用 `/mcp` 并确认 `tools/list` 返回 14 个 Ombre 工具；不能只看容器为 running。升级前备份 `/opt/ombre-brain/buckets`，保留当前镜像和源码 commit。失败时执行：

```bash
docker image ls 'sooya-ombre-brain'
docker compose --env-file /opt/ombre-brain/.env -f /opt/ombre-brain/compose/docker-compose.yml down
# 将 OMBRE_SOURCE_DIR 指回已验收的旧 commit 后重新 up -d --build
```

SOOYA 的旧 SQLite 记忆在迁移观察窗内保留，只读迁移脚本默认为 dry-run；只有明确执行 `--apply` 才会调用 Ombre `hold`。迁移输出 JSONL、manifest 和 receipt 应与 Ombre buckets 一起备份。
