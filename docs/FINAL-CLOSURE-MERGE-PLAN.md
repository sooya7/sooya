# SOOYA 最终收口与合并方案

> 分支：`upgrade/core-systems-stabilization`  
> 交付文档提交：`6e3bc69`  
> 当前代码交付版本：`7962eb3`  
> 基线：`main@319a36c`

## 目标

把当前“本地全量测试通过”的升级版收口为：

- 远端 CI 可证明；
- Proactive 与用户回复真正统一调度；
- 语音实际内容与 transcript 一致；
- 可安全升级与回滚；
- 最终可以合并 `main`。

当前不再增加天气、地点、A/B、完整管理 UI 等新功能。


---

## P0-1：Proactive 真正进入 ReplyCoordinator

### 现状

当前已经有：

- `replyBatches.openBatch()` 冲突保护；
- 用户出现后的二次检查；
- proactive voice 走 `VoiceService`。

但最终 proactive 仍由 `ProactiveComposer` 直接 `messages.createInTransaction()` 发布，不算真正进入统一 Coordinator。

### 修改

新增：

```ts
ReplyCoordinator.enqueueProactive(task)
```

建议任务结构：

```ts
interface ProactiveDeliveryTask {
  candidateId: string;
  requestedMode: ProactiveMode;
  run(signal: AbortSignal): Promise<PreparedProactiveReply>;
}
```

优先级：

```text
用户 collecting / queued / generating / publishing
> proactive
```

用户消息一旦出现：

```text
proactive planned        → cancel
proactive chat generating → abort
proactive TTS generating  → abort
proactive image generating→ abort
尚未发布                  → discard
已发布                    → 不撤回
```

同时保证同一 proactive candidate 只能成功发送一次。建议增加 DB claim 或 partial unique index。

### 验收

- reply 进行中 proactive blocked；
- proactive chat/TTS 中用户出现，底层 AbortSignal 真正触发；
- 两个 worker 同抢一个 candidate，只允许一个成功；
- proactive 不产生半条消息或重复消息。


---

## P0-2：修正 Voice transcript 与实际音频不一致

### 现状

交付文档写的是：

```text
transcript 保存完整 spokenText
synthesisText 按 maxChars 裁剪
```

对于 `replace / voice-only` 不正确，因为用户可能只听到前半段，但 transcript 却显示完整内容。

### 修改

规则改为：

```text
transcript = 实际说出的 spokenText
synthesisText = spokenText 的发音归一化版本
```

`synthesisText` 只允许：

- Markdown 清理；
- 标点/停顿归一化；
- 数字/缩写朗读归一化；

不能删除回答语义。

#### replace / voice-only

禁止字符硬裁剪。

```text
spokenText 超长
→ compact rewrite 1 次
→ 仍超长
→ 不发送残缺音频
→ 回退完整文字
```

#### complement

可以缩短，但只能按完整句子边界截断。

#### summary

生成阶段直接限制长度，不再机械裁剪。

### 验收

- replace 超长会 compact；
- compact 失败会完整文字 fallback；
- transcript 与实际音频内容一致；
- 不存在“音频 300 字，transcript 500 字”。


---

## P0-3：取消模型自行 `voice-only`

### 现状

用户明确 `voice-only` 已走 hidden draft，但模型自行输出 `[[voice-only]]` 仍可能出现文字先显示再被替换。

### 推荐修改

`replace / voice-only` 只允许由明确用户意图触发：

```text
只发语音
用语音回我
不要打字
```

模型自动语音最多允许：

```text
complement
summary
```

兼容旧 marker 时：

```ts
if (model.voiceOnly && !user.voiceOnly && !user.explicitVoiceReply) {
  mode = 'complement';
}
```

逐步废弃模型侧 `[[voice-only]]`。

### 验收

- 用户 voice-only：hidden draft；
- 模型自行 voice-only：降级 complement；
- 普通文字流式输出不受影响；
- 不再出现文字闪现后删除。


---

## P0-4：最终 GitHub CI 必须在 HEAD 上全绿

当前文档记录的：

```text
typecheck 0 error
server 591/591
web 444/444
build success
E2E 84/84
```

先标记为“本地门禁通过”。

最终修复完成后：

```text
push final HEAD
→ 创建 PR 到 main
→ 等 GitHub Actions
```

最终必须通过：

```bash
npm ci
npm run typecheck
npm test -w @sooya/server
npm test -w @sooya/web
npm run build
npm run test:e2e
```

以及仓库已有：

- dependency audit；
- release package validation；
- Docker build；
- container readiness。

交付文档最终记录：

```text
Local verification: PASS
GitHub CI: PASS
Final SHA: <sha>
CI Run: <run id>
```


---

## P0-5：安全回滚

### 文档必须删除

不要再写：

```text
切回旧代码即可
```

v15 后存在：

```text
generating
publishing
superseded
```

旧代码并不能完整处理这些新状态。

### 推荐回滚方式

#### 首选

```text
停止服务
→ 恢复升级前 DB backup
→ checkout 旧 release
→ 启动
```

#### 保留新 DB 降代码

必须先维护模式：

```text
停止接收新消息
停止 background jobs
等待正常请求结束
```

状态归一：

```text
generating + visible_at IS NULL → queued
publishing + visible_at IS NOT NULL → completed
superseded → cancelled
```

旧版启动前不得残留：

```text
generating
publishing
superseded
```

建议新增：

```bash
npm run rollback:preflight
npm run rollback:normalize
```

`preflight` 只检查。  
`normalize` 必须显式执行并输出修改项。

还要检查：

```text
pending voice generation = 0
pending proactive publication = 0
migration transaction complete
```


---

## P0-6：修正 `UPGRADE-DELIVERY.md`

必须改以下内容：

### 版本

```text
代码交付版本：7962eb3
交付文档版本：6e3bc69
最终验收版本：<FINAL_SHA>
```

### Proactive 描述

F2 完成前不要写：

```text
主动消息统一 — 完成
```

应写：

```text
主动消息冲突保护 — 完成
主动语音 VoiceService 接入 — 完成
Proactive Coordinator 统一调度 — 待完成
```

F2 完成后再改成“统一调度完成”。

### 门禁

CI 尚未在最终 HEAD 跑过时：

```text
本地门禁：PASS
GitHub CI：PENDING
```

### 回滚

替换为本方案 P0-5。

### voice-only 已知限制

完成 P0-3 后删除旧限制，并写：

```text
模型自动语音仅允许 complement/summary；
replace 仅由明确用户指令触发。
```


---

## P1-1：Feature Flag 回退测试

不能只确认 flag 被读取，要验证关闭后系统仍正常。

至少覆盖：

```text
REPLY_INTERRUPTIBLE_GENERATION=false
VOICE_V2_ENABLED=false
VOICE_INDEPENDENT_SCRIPT_ENABLED=false
VOICE_NATURALNESS_GUARD_ENABLED=false
VOICE_ADVANCED_DELIVERY_ENABLED=false
VOICE_AUTO_COMPLEMENT_ENABLED=false
VOICE_READ_ALOUD_ENABLED=false
ENABLE_LIFE_V2=false
```

要求：

- 不 crash；
- API 契约合法；
- 不生成半新半旧状态；
- DB 新 schema 存在时旧路径仍能工作。

建议新增：

```text
feature-flags.test.ts
```


---

## P1-2：真实数据库 migration 测试

新增脱敏 fixture：

```text
tests/fixtures/db-v14.sqlite
```

测试：

```text
v14 DB
→ run migrations
→ v17
→ verify data
```

必须检查：

- legacy `running` 转换；
- assistant_message_id 不丢；
- reply_batch_messages 顺序不丢；
- FK 完整；
- message / life / proactive / settings / media 引用不丢；
- migration 中途失败会 transaction rollback。


---

## P1-3：跨系统重启恢复测试

新增联合 restart E2E：

### Reply hidden generation

```text
generating
→ kill
→ restart
→ same revision regenerate
→ 只产生一条最终回复
```

### Reply publishing

```text
已 visible
→ kill
→ restart
→ completed(partial)
→ 不重新覆盖已显示内容
```

### Voice

```text
TTS synthesizing
→ kill
→ restart
→ 不留下永远 pending 的 audio
```

### Proactive

```text
candidate preparing
→ kill
→ restart
→ 不重复主动发送
```

### Life

```text
active plan/thread
→ kill
→ restart
→ outcome 只结算一次
```


---

## P1-4：Proactive 去重增加 DB 保证

当前业务层去重不足以对抗真正并发。

推荐最小方案：

```sql
CREATE UNIQUE INDEX idx_proactive_candidate_sent_once
ON proactive_attempts(candidate_id)
WHERE status = 'sent' AND candidate_id IS NOT NULL;
```

第二个并发发送者收到 conflict 后：

```text
blocked: candidate_already_sent
```

如果未来考虑多实例，升级为：

```text
ready → claimed → shared / expired
```

的候选 lease 状态机。


---

## P1-5：Voice 语义一致性守卫

Naturalness Guard 解决“自然不自然”和“是否复读”，但不能完全保证 voice 没新增事实。

增加轻量：

```ts
VoiceSemanticGuard
```

重点比较：

- 数字；
- 日期/时间；
- 金额；
- 地点；
- 专名；
- 否定词；
- 明确承诺词。

发现 voice 增加高风险事实：

```text
complement → drop voice
replace → fallback canonical text
summary → regenerate 1 次
```

长期再升级为统一 `ReplySemanticPlan`。


---

## P1-6：最终观测指标

### Reply

```text
reply_interrupt_count
reply_superseded_count
reply_auto_retry_count
reply_partial_count
reply_failure_count
reply_first_visible_ms
```

### Voice

```text
voice_mode_count
voice_script_rewrite_count
voice_naturalness_reject_count
voice_cancel_count
voice_tts_failure_count
voice_fallback_text_count
```

### Life

```text
life_plan_created
life_plan_completed
life_plan_skipped
life_thread_created
life_thread_resolved
life_repeat_penalty_triggered
```

### Proactive

```text
proactive_sent_count
proactive_user_appeared_cancel_count
proactive_reply_in_progress_block_count
proactive_duplicate_block_count
```

运行日志不要记录完整私人文本。


---

## P1-7：灰度上线

### Phase 1

```text
Interruptible Reply ON
Voice V2 仅明确用户请求
Life V2 ON
Proactive OFF
```

### Phase 2

开启：

```text
voice complement
voice summary
```

### Phase 3

开启：

```text
Life proactive text
```

### Phase 4

最后开启：

```text
proactive voice
```

每一阶段观察一段时间后再扩大。


---

## P2：本轮不阻断

以下可以后续再做：

- Weather Snapshot；
- 真实 Location model；
- Life Admin 完整 UI；
- Voice Preferences 完整 UI；
- Shadow；
- A/B；
- 高级多 segment prosody；
- diversity / naturalness dashboard。

本轮不要继续扩 scope。


---

## 推荐剩余 Commit 顺序

```text
1. fix(voice): preserve transcript and audio content integrity
2. fix(voice): restrict model-driven voice-only to complement
3. refactor(proactive): route delivery through coordinator and abort on user activity
4. fix(proactive): make candidate publication idempotent
5. test(core): cover feature flags migration restart and proactive races
6. chore(rollback): add downgrade preflight and normalization tooling
7. docs(upgrade): correct version rollback proactive and CI wording
8. test(e2e): cover final cross-system acceptance
9. docs(upgrade): record final CI and merge readiness
```


---

## 最终 E2E

### Reply

- 连续 3 条只回复一次；
- hidden generation 中继续发消息会 abort；
- visible 后新消息进入 next batch；
- timeout 一次 retry 成功；
- timeout 两次只显示一张 failure card；
- partial 不丢已显示内容；
- restart 不重复回复。

### Voice

- `用语音回我` 不复读正文；
- `只发语音` 无文字闪烁；
- replace 超长先 compact，不硬裁；
- compact 失败回完整文字；
- transcript 与实际音频一致；
- manual cancel 真取消 provider；
- stale revision 音频丢弃；
- 模型自行 voice-only 降级 complement；
- read_aloud 不产生重复消息。

### Life

- sleep 恢复 energy；
- conversation plan 真执行；
- active → completed；
- missed → skipped；
- thread create → advance → resolve；
- 时区跨午夜正确；
- restart 不重复 outcome。

### Proactive

- reply 进行中 blocked；
- proactive chat/TTS 中用户出现立即 abort；
- 同 candidate 并发只成功一次；
- 已发布后不撤回；
- proactive voice 使用独立口语脚本。


---

## 最终合并标准

只有全部满足才标记：

```text
READY TO MERGE
```

### P0

全部完成。

### 测试

```text
typecheck PASS
server PASS
web PASS
build PASS
E2E PASS
GitHub CI PASS on final HEAD
```

### 数据

- v14 → v17 fixture migration PASS；
- rollback preflight 可用；
- 不存在无法降级的 open state。

### 文档

`UPGRADE-DELIVERY.md` 最终记录：

```text
code SHA
document SHA
final SHA
CI run
migration version
rollback procedure
known limitations
feature flag matrix
```

完成后，这一版才可以从“本地全量验证通过”升级为“可安全合并 main 的正式交付版本”。
