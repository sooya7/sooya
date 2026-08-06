# SOOYA Web 性能与 UI 重构设计

**日期：** 2026-08-06
**基线：** `main` at `4b7dd6e`
**范围：** `packages/web` 的页面切换、流式回复、媒体占位与聊天视觉体系

## 目标

在不改变 SOOYA 单用户、单人格、单会话产品模型的前提下，解决以下已核实问题：

1. 聊天、图库和管理后台之间通过完整文档导航切换，聊天状态、SSE 和滚动位置随 React 根节点销毁。
2. `reply.text.delta` 已不再执行 `Map + sort`，但仍通过 `find + map` 扫描和复制整个消息数组，成本随已加载历史增长。
3. 消息图片的 Blob 尚未解析时，`.image-part` 没有稳定宽高，占位高度可能为零并产生布局跳动。
4. 当前只有浅色主题；聊天背景、气泡和共享表面仍偏向工程默认观感。

交付结果应使内部页面切换无需重新加载文档，聊天会话在切换期间连续，流式草稿更新与历史长度解耦，图片加载前后布局稳定，并按已确认的“暖调陪伴感”建立浅色和深色语义化视觉体系。

## 审查结论与修正

作为输入的 Notebook 提供了有效的关注方向，但部分结论已与当前代码不符：

- **不新增 IndexedDB 媒体缓存。** 媒体响应已经使用 `Cache-Control: private, max-age=604800, immutable`、强 ETag 和 304；前端也已取消 `cache: 'no-store'` 并实现 96MB / 240 条的进程内 LRU。IndexedDB 会重复保存私有 Blob，并引入配额、失效、登出清理和隐私边界。
- **流式路径仍需优化，但不是报告所述的 `Map + sort`。** 当前 `applyDraft` 对每个 delta 执行一次 `find` 和一次 `map`。设计将草稿从 finalized messages 中分离，而不是只增加索引后继续复制数组。
- **图库的大图批量加载问题已经缓解。** 当前网格走 `?w=` WebP 缩略图，并逐张发布、单项失败隔离。此次不重写图库加载器。
- **骨架 shimmer 已存在。** 此次复用现有动效语言，只补齐媒体占位和深色 token，不重复实现已有能力。

## 选定方案

采用“轻量 SPA 共享壳层”，不引入 React Router 或新的状态管理依赖。

共享壳层负责三件事：

1. 将明确标记的聊天、图库、后台内部链接转换为 History API 导航。
2. 在用户首次进入聊天后保持 `useChat` 会话宿主存活，使消息、SSE、活动状态和媒体 LRU 不随视图切换销毁。
3. 只挂载当前可见的页面 DOM；图库和后台离开即卸载，聊天视图离开时保存恢复信息并卸载 DOM，但聊天会话宿主继续运行。

这种结构避免同时隐藏三棵大型 DOM，也避免 `display: none` 导致虚拟列表测量为零、可访问性树混乱或后台页面继续执行不必要布局。

## 组件与职责

### 轻量路由层

新增一个小型路由模块，集中提供：

- `classifyRoute(pathname)`：识别 `chat`、`gallery`、`admin`；未知路径保持当前兼容行为并落到聊天视图。
- `navigate(path, options)`：调用 `history.pushState` 或 `replaceState`，再通知共享壳层更新 route kind。
- `AppLink`：只拦截同源、主鼠标键、无修饰键、无 `download`、无非 `_self` target 的明确内部链接。
- `popstate` 订阅：支持浏览器前进和后退。

外链、新标签打开、下载、带修饰键点击和未接入的普通 `<a>` 保持浏览器原行为。直接刷新 `/`、`/gallery`、`/admin/*` 继续依赖现有服务端 SPA fallback。

管理后台内部标签已经使用 History API；它可以保留当前逻辑。顶层路由只关心 route kind，后台内部从 `/admin/models` 切到 `/admin/operations` 不会重建整个 `AdminPanel`。

### AppShell 与 ChatSessionHost

`AppShell` 按 route kind 挂载当前页面：

- `chat`：渲染 `ChatSessionHost` 的聊天视图和 `ImageViewerHost`。
- `gallery`：渲染 `GalleryPage`。
- `admin`：渲染 `AdminPanel`。

`ChatSessionHost` 首次访问聊天时创建，此后在同一文档生命周期内保持挂载并只调用一次 `useChat`。当聊天不是当前路由时，宿主返回 `null`，但 hook 状态和 `ChatStream` 继续存在；返回聊天时重新挂载纯视图层，避免第二次 bootstrap 和 SSE 重连。

聊天视图卸载前保存：

- `scrollTop`；
- 是否处于接近底部状态。

返回时，如果离开前在底部，则在虚拟列表完成测量后滚动到最新消息；否则恢复原 `scrollTop`。新消息只追加到末尾，不会改变先前历史的顶部偏移。引用面板、搜索面板等临时 UI 可以按现有完整导航语义重置；输入草稿继续使用现有持久化机制。

初始地址为后台或图库时，不预先建立聊天连接；只有首次访问聊天才创建会话宿主。

## 流式回复数据流

`useChat` 的 finalized `messages` 状态只保存服务端已接收或本地乐观发送的正式消息。新增独立的 `streamingDraft` 状态：

```ts
interface StreamingDraft {
  id: string;
  text: string;
  createdAt: string;
}
```

事件行为如下：

1. 首个 `reply.text.delta` 创建草稿；后续相同 `messageId` 只累积 `streamingDraft.text`。
2. delta 不调用 `mergeMessages`、`find`、`map` 或 `sort`，也不改变 finalized `messages` 数组引用。
3. `reply.completed` 清除匹配草稿，并只把最终服务端消息合并一次。
4. `reply.failed` 和完整 `reload` 会清理草稿。普通 resync 不盲目清理；当 catch-up 合入与草稿同 id 的正式消息时再清理，避免窗口重新聚焦时让仍在生成的草稿闪烁消失。
5. 若意外收到新的 `messageId`，新草稿替换旧草稿；服务端仍以串行回复为正常前提。

聊天视图在虚拟化历史列表之后单独渲染流式草稿气泡。这样每个 delta 的数据更新成本不再随历史消息数量增长。活动文案只有在状态真正变化时才创建新对象，避免重复的等值状态更新。

## 媒体缓存与鉴权边界

保留现有媒体链路：

```text
组件 → 作用域内存 LRU → 浏览器 private HTTP cache → 服务端 ETag / immutable
```

缓存键继续区分 `user` 与 `admin` scope，并移除 URL 中的凭据参数。为共享页面进程补充 scoped clear：

- `clearMediaCache()`：清空全部作用域，保留现有测试用途。
- `clearMediaCache('user')`：只清除用户媒体。
- `clearMediaCache('admin')`：只清除管理员媒体。

用户或管理员令牌被替换、清除或判定失效时，必须清理对应 scope，防止新凭据复用旧凭据产生的 Blob URL。清理一个 scope 不得撤销另一个 scope 正在显示的 URL。

不把 Authorization 响应写入 Service Worker Cache API，也不新增 IndexedDB Blob 存储。

## 图片占位与失败状态

`MessageItem` 在媒体 URL 尚未解析时仍渲染 `.image-part` 容器：

- 媒体元数据有宽高时使用真实 `aspect-ratio`。
- 缺少宽高时使用 `4 / 3`。
- 容器在桌面端不超过 260px，在窄屏继续服从现有 `62vw` 上限。
- 加载时设置 `aria-busy="true"` 并显示复用现有 token 的轻量 shimmer。
- 图片到达后填充同一容器，不改变外部几何尺寸。
- 加载失败时替换为现有错误气泡；文字片段和其他媒体片段不受影响。

占位按钮在图片未就绪时不执行无意义的大图打开操作。真实图片可用后恢复当前查看器行为。

## UI 视觉系统

采用已确认的“暖调陪伴感”，信息架构、图标体系和 900px 桌面聊天宽度不变。

### 浅色主题

- 页面背景使用极淡暖白到薰衣草渐变，聊天栏仍保持聚焦窄栏。
- 对方气泡使用暖白表面、细边框和极弱阴影；自己的气泡保留紫色渐变。
- 双方使用不同的尾角和圆角语言，避免所有内容都像同一种卡片。
- 顶栏与输入区使用轻微半透明表面，但正文和图标仍满足 WCAG AA 对比度。
- 表情包增加克制的承托表面，不改变素材本身。

### 深色主题

使用 `prefers-color-scheme: dark` 覆盖语义 token，形成暖黑紫背景和低饱和表面，而不是采用高亮霓虹的“深色优先”方案。聊天、图库和后台的核心背景、面板、文本、边框、遮罩和交互状态都必须有对应 token；不得只把聊天页变暗而留下刺眼的浅色后台。

现有可访问性约束继续有效：正文对比度至少 4.5:1，大型图标和边界至少 3:1，焦点轮廓在两种主题下可见，触控目标不缩小。

### 动效边界

不对所有 `.msg-row` 添加挂载动画。虚拟列表在滚动时会反复挂载可见行，全局入场动画会让旧消息重复闪动。仅保留按钮、真实加载状态和新媒体占位的轻反馈，并继续尊重 `prefers-reduced-motion`。

## 错误处理

- 内部路由无法处理的链接回退到浏览器默认导航，不吞掉用户操作。
- 聊天在后台路由期间若断线或鉴权失败，状态原样保留；返回聊天时展示现有离线或令牌门禁，不静默重建会话。
- 图库和后台错误保持页面局部，不得清空常驻聊天会话。
- route view 卸载必须执行现有 AbortController、对象 URL 引用和事件监听清理。
- 滚动恢复值必须限制在当前列表可用范围；虚拟列表未完成测量前不强行设置最终位置。
- 媒体 scope 清理不得跨作用域撤销仍在显示的 Blob URL。

## 测试策略

### 路由与会话

- `classifyRoute` 覆盖根路径、图库、后台子路径和未知路径。
- `AppLink` 覆盖普通内部点击、修饰键、新标签、下载和外链。
- 前进、后退会切换正确视图。
- 聊天 → 后台 → 聊天期间 `useChat` / bootstrap / `ChatStream` 只创建一次。
- 初始后台或图库路由不会建立聊天连接；首次访问聊天才建立。
- 图库和后台离开时卸载；聊天 session state 保留。
- 返回聊天时分别验证“原本在底部”和“原本浏览历史”两种滚动恢复。

### 流式回复

- 多个 delta 累积到同一个 `streamingDraft`。
- delta 前后的 finalized `messages` 引用保持相同，证明路径不扫描或复制历史数组。
- completed 只合并一个最终消息并清除草稿。
- failed 与完整 reload 清除草稿；普通 resync 保留草稿，合入同 id 正式消息时才清除。
- 现有活动文案、乐观消息、重试、撤回和 catch-up 测试继续通过。

### 媒体与视觉

- scoped cache clear 只撤销目标 scope。
- 令牌设置、替换、清除和 401 路径触发对应清理。
- 图片 URL 未就绪时容器已有非零比例、`aria-busy` 和骨架；就绪后几何比例不变。
- 浅色和深色主题检查正文、边框、焦点、错误态、图库、后台与模态遮罩。
- 375px、小屏横屏、900px 以上桌面宽度均无横向溢出。
- reduced motion 下 shimmer 和交互动效被压缩或禁用。

## 验收标准

1. 同一文档内执行聊天 → 后台/图库 → 聊天，不产生第二次 `/api/bootstrap`，不创建第二个 SSE 连接。
2. 浏览器前进和后退可在三个 route kind 间可靠切换；直接刷新各路由仍可打开。
3. 任何 delta 都不改变 finalized `messages` 数组引用；最终消息只在完成时合并一次。
4. 图片请求未完成时，消息列表已为图片保留稳定空间。
5. 用户与管理员令牌变化不会复用旧 scope 的内存 Blob。
6. 浅色与系统深色主题覆盖聊天、图库和后台的核心表面，并通过对比度与键盘焦点检查。
7. 前端现有 30 个测试文件、401 个测试在改动前后均通过；新增测试、类型检查和生产构建通过。
8. 浏览器回归确认 bootstrap 与 SSE 数量、滚动恢复、媒体缓存命中和前进/后退行为。

## 交付切片

这份设计覆盖三个关联但可独立验收的切片，实施计划不得把它们混成一个不可审查的大提交：

1. **路由与会话切片：** 轻量路由、`AppShell`、`ChatSessionHost`、前进/后退和滚动恢复。完成后页面切换已不再重启聊天。
2. **流式与媒体稳定性切片：** 独立 `streamingDraft`、scoped media clear 和图片稳定占位。完成后高频回复路径与媒体加载行为可独立验证。
3. **视觉体系切片：** 暖调浅色 token、配套深色 token、气泡和共享表面调整。该切片不改变数据流，可在前两片稳定后单独视觉回归。

每个切片都使用测试先行、独立提交和独立验证。若其中一片需要回退，不应迫使另外两片一起回退。

## 预计文件边界

- 新增：路由模块、`AppShell`/会话宿主及对应测试。
- 修改：`packages/web/src/main.tsx`、`packages/web/src/App.tsx`。
- 修改：`packages/web/src/lib/useChat.ts` 与测试。
- 修改：`packages/web/src/lib/authenticatedMedia.ts`、令牌模块与测试。
- 修改：`packages/web/src/components/MessageItem.tsx` 与测试。
- 修改：`packages/web/src/styles.css`、`AdminPanel.css`、`overlays.css` 和必要的共享样式测试。
- 文档：更新 `docs/LIMITATIONS.md` 中浅色主题与媒体缓存边界。

## 明确不做

- 不增加 IndexedDB 或 Service Worker 私有媒体缓存。
- 不引入 React Router、Redux 或其他新运行时依赖。
- 不修改服务器 API、数据库、模型提供商或回复协议。
- 不重写已经使用缩略图和渐进发布的图库加载器。
- 不全面重设计管理后台的信息架构。
- 不给虚拟化消息列表添加全局挂载动画。
- 不改变单用户、单人格、单会话产品模型。
