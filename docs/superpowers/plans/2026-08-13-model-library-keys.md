# 模型库绑定密钥实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型库预设在服务器端绑定创建时的模型密钥，应用预设时同时切换接口、模型和密钥，同时保持旧预设兼容且绝不通过管理接口回传密钥。

**Architecture:** 模型库继续使用 `SettingsRepo` 持久化，但内部存储对象增加仅服务器可见的可选 `apiKey` 字段。浏览器不再通过普通批量保存创建新预设；新增“从当前配置创建预设”的管理接口，由服务器根据 slot 读取当前已解析的密钥并绑定。读取和批量更新只返回/接受无密钥的公开预设，应用时服务器按预设是否带有内部 `apiKey` 决定切换或兼容保留当前密钥。

**Tech Stack:** Node.js 20, Fastify, Zod, SQLite `SettingsRepo`, TypeScript, Vitest, React/Vite。

---

### Task 1: 服务器端预设存储与应用行为

**Files:**
- Modify: `packages/server/src/routes/admin.ts`
- Test: `packages/server/test/model-presets.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖三条行为：从当前 chat 配置创建预设时服务器绑定真实 key；GET 只返回 `apiKeyBound`/`apiKeyConfigured` 状态而不含 key；应用绑定预设时切换 key，旧的无 key 预设仍保留当前 key。

- [ ] **Step 2: 运行模型库测试确认测试因接口不存在而失败**

运行 `npm run test -w @sooya/server -- model-presets.test.ts`，预期新增测试失败，原因是新建接口未注册或应用接口尚未使用存储 key。

- [ ] **Step 3: 实现内部/公开预设边界**

在 `admin.ts` 中增加 `StoredModelPresetSchema`、`readStoredPresets` 和 `publicPreset`：内部预设允许可选 `apiKey`，公开返回删除 `apiKey` 并增加布尔字段 `apiKeyConfigured`。保留现有 `models.presets` 旧数组读取与 STT 清理逻辑。

- [ ] **Step 4: 增加服务器创建接口并绑定当前 slot 的 key**

注册 `POST /api/admin/model-presets/from-current`，只接受公开 `preset`，校验 slot/provider/model/baseUrl 等字段，从当前已解析模型配置中读取对应 slot 的 key，写入内部预设；重复 id 和 60 条上限继续按现有规则拒绝。

- [ ] **Step 5: 应用时切换绑定 key并保留旧预设兼容**

应用内部预设时：存在 `apiKey` 字段就把它写进目标 slot（包括空字符串）；旧预设没有该字段则不发送 `apiKey`，沿用当前配置。这样新建的无 key 预设可明确清空 key，历史预设不会突然失效。

- [ ] **Step 6: 运行模型库测试确认通过**

运行 `npm run test -w @sooya/server -- model-presets.test.ts`，预期该文件全部通过。

### Task 2: 前端走服务器创建接口并显示配置状态

**Files:**
- Modify: `packages/web/src/lib/admin.ts`
- Modify: `packages/web/src/lib/modelPresets.ts`
- Modify: `packages/web/src/components/AdminPanel.tsx`
- Test: `packages/web/src/lib/admin.test.ts`
- Test: `packages/web/src/lib/modelPresets.test.ts`
- Test: `packages/web/src/components/AdminPanel.test.tsx`

- [ ] **Step 1: 写失败测试**

断言 `adminApi.addModelPreset` 使用新接口且只发送公开预设；模型库类型接受 `apiKeyConfigured`；当前表单有未保存 key 时点击“存入模型库”会提示先保存，不会创建无意的旧 key 预设。

- [ ] **Step 2: 运行前端相关测试确认失败**

运行 `npm run test -w @sooya/web -- admin.test.ts modelPresets.test.ts AdminPanel.test.tsx`，预期新 API 调用和交互断言失败。

- [ ] **Step 3: 实现 API 和前端调用**

在 `adminApi` 增加 `addModelPreset`；`AdminPanel` 的“存入模型库”改为调用服务器创建接口，编辑/删除仍使用公开批量保存；若 `keyDraft` 非空则提示先保存当前配置；模型库行显示“密钥已配置/未配置”，不渲染密钥内容。

- [ ] **Step 4: 运行前端相关测试确认通过**

重新运行上述 Vitest 命令，预期全部通过。

### Task 3: 全量验证与发布前审计

**Files:**
- Modify: `packages/server/src/config/schema.ts` only if public schema comments/types require synchronization
- Modify: `packages/web/src/lib/modelPresets.ts` comments/types as needed

- [ ] **Step 1: 检查差异和密钥泄漏路径**

确认 `git diff` 中没有把真实 key 写入测试以外的前端请求、公开响应、日志或文档；确认旧模型库数组可读取，新增预设只由服务器绑定 key。

- [ ] **Step 2: 运行完整服务器和前端测试**

运行 `npm test` 和 `npm run test -w @sooya/web`，记录实际通过数和失败数。

- [ ] **Step 3: 运行类型检查和构建**

运行 `npm run typecheck` 与 `npm run build`，确保 server/web 编译和生产构建通过。

- [ ] **Step 4: 复核线上基线与分支差异**

确认工作分支基于最新 `origin/main`，仅包含本次模型库密钥绑定相关文件；不修改主工作区未提交内容。
