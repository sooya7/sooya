# SOOYA PR #1 M-001～M-024 核验记录

| 编号 | 当前核验状态 | 证据与处理决定 |
|---|---|---|
| M-001 | 确定存在 | 原始 Head `bd2db8b` 缺失 `media/store.ts`、`media/stickers.ts`；干净 typecheck/build 失败。仅同步这两个文件。 |
| M-002 | 确定存在 | Run 30435357087 的 E2E 连续超时，35 分钟 job timeout 后取消；诊断因 cancelled 被跳过。 |
| M-003 | 报告误判 | 模拟运行时超出唯一范围；事实库功能另按第 8 项核验。 |
| M-004 | 确定存在 | 正式回复直接 `synthesize(clipped)`，未读取保存的情绪映射。 |
| M-005 | 测试不足 | 待按 ContextBuilder 实际预算路径补充核验。 |
| M-006 | 确定存在 | 临时 HTTP/网络错误达到六次即删除订阅。 |
| M-007 | 已被后续提交修复 | 当前 ImageViewer 使用 Pointer Capture；仍需真机异常释放验证。 |
| M-008 | 无法确认 | 待核验预览与 apply 的报告绑定路径。 |
| M-009 | 无法确认 | 待核验文件与数据库删除补偿路径。 |
| M-010 | 确定存在 | `adminMediaUrl()` 将管理令牌拼入 query。 |
| M-011 | 确定存在 | 媒体仓库使用 `value_json LIKE '%id%'`。 |
| M-012 | 测试不足 | 待核验 ZIP 实际内容。 |
| M-013 | 无法确认 | 待核验 SW 缓存键版本行为。 |
| M-014 | 真机待验证 | 历史状态需 E2E 复现。 |
| M-015 | 真机待验证 | 移动端滚动长按需复现。 |
| M-016 | 报告误判 | 当前实现并非报告假定的 touchmove passive 路径。 |
| M-017 | 无法确认 | 待核验 LIKE 转义实现与测试。 |
| M-018 | 无法确认 | 待核验归一化与数据库唯一约束。 |
| M-019 | 无法确认 | 待比较 preview 与 apply 统计。 |
| M-020 | 测试不足 | 待核验保存后 capability 刷新。 |
| M-021 | 测试不足 | 待大数据量 UI 验证。 |
| M-022 | 测试不足 | 待 2000 条导入事务验证。 |
| M-023 | 无法确认 | 待核验可见性同步失败补偿。 |
| M-024 | 测试不足 | 待 UI 选择态验证。 |

## M-001 取证

原始 Head 在干净 `npm ci` 后，Server typecheck 与 build 均报 `TS2307`，指向缺失的 `./media/store.js` 和 `./media/stickers.js`；服务端测试有 9 个套件无法导入。同步两个文件后，Server/Web typecheck 与 production build 均成功。Windows 本地剩余服务端测试失败另行记录，不归因于缺失模块。

## M-002 取证

GitHub Actions Run `30435357087` 的 E2E 自 08:26:27 运行，多个用例每次超时 60 秒并重试；08:59:33 输出 `The operation was canceled`。工作流 job 配置 `timeout-minutes: 35`，时间线符合 job 超时。并发策略虽启用 `cancel-in-progress`，但没有后继 run 覆盖该 run 的证据。
