# HANDOFF

## 当前状态
- 当前分支：`perf/static-cache-headers`（从 `main` @ `b476cd6` 切出）
- 最新提交：见下方「Git」
- 工作区状态：干净

## 本轮完成
- 现网加载性能实测（echo.sooya.icu，Chrome + CDP）：定位「每次加载都很慢」的真实原因。
- 修复静态资源缓存策略：`@fastify/static` 之前用默认值发 `Cache-Control: public, max-age=0`，
  导致每次加载每个 JS/CSS/图标都要回源验证；Cloudflare 边缘永远是 REVALIDATED 而不是 HIT。
  现在带内容哈希的产物是 `immutable` 一年，入口文件（html / sw.js / webmanifest）是 `no-cache`，
  其余静态文件缓存一天。

## 实测数据（一次刷新，2026-07-31，海外住宅代理出口，绝对值偏慢但占比成立）
- 首屏绘制 0.54s；整页图片加载完 10.6s；总下载 2.66 MB。
- 最大单项：`/api/media/media_ms8dn6…` 原图 2.27 MB / 8.09s，另一张 378 KB / 2.68s。
- 任意请求（含 66 字节的 401）TTFB 都是 0.30–0.55s：每个请求都穿 Cloudflare Tunnel 回源。
- 首屏 API 串行 4 次：`/api/conversation`、`/api/messages`、`/api/stickers`、`/api/life`。
- `public/icons/sooya-photo-1024.png` 有 2.6 MB。

## 当前未完成
- 媒体没有缩略图：`/api/media/<id>` 只吐原图，聊天气泡显示两三百像素也要下 2 MB。
- 首屏 4 个 API 各占一次回源往返，可合并。
- PWA 图标体积过大（1024 那张 2.6 MB）。

## 当前阻塞
- 无。但本轮修复需要重新发布到 echo.sooya.icu 才会生效（本轮没有服务器访问权限，未部署）。

## 验证结果
- `npx vitest run test/static-cache.test.ts`：8/8 通过。
- `npx vitest run`（服务端全量）：45 个文件 / 423 个用例全部通过。
- `npx tsc -p packages/server/tsconfig.json --noEmit`：通过。
- 未执行：web 包测试、Playwright e2e、生产部署验证。

## 下一轮唯一优先任务
给媒体加缩略图：`GET /api/media/<id>?w=480` 返回按宽度缩放并缓存到磁盘的变体（原图仍由不带 `w`
的请求返回），聊天气泡和画廊列表改用缩略图，点开大图才取原图。要求：变体落盘复用、ETag 随
`id+w` 变化、保持 `private, max-age=604800, immutable`，并补服务端用例（缩放命中、非法 `w` 回退、
非图片类型不处理）。预期把单次加载的 2.66 MB 降到 150 KB 量级。

## 相关文件
- `packages/server/src/app.ts`（`staticCacheControl` 与静态资源注册）
- `packages/server/test/static-cache.test.ts`
- `packages/server/src/routes/media.ts`（下一轮改这里）
- `packages/web/src/lib/authenticatedMedia.ts`（前端媒体缓存与取图路径）
