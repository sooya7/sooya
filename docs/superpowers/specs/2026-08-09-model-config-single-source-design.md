# 模型配置单一来源与联网搜索设计

## 目标

所有模型能力都在现有管理后台的“模型配置”页面管理，同时允许运维人员直接编辑服务器上的同一份配置文件。页面配置、服务器文件和运行时使用的配置必须一致；保存或修改后热生效，不要求编辑 `.env` 或重启服务。

联网搜索不是新的管理菜单或独立页面。它作为“模型配置”左侧能力列表中的一个同级项目，与聊天、视觉、总结、Embedding、Rerank、图片和语音并列。

## 单一配置源

唯一持久化来源为：

```text
/opt/sooya/shared/config/models.json
```

管理页面通过现有 `GET/PUT /api/admin/models` 读写该文件。服务器直接编辑同一文件后，进程通过文件监听校验并热加载，管理页面再次获取时显示更新后的值。

模型和搜索相关环境变量只用于从旧版本首次迁移。配置文件升级到新存储版本后，运行时不再读取这些环境变量，也不允许它们覆盖页面或文件中的值。端口、数据目录、代理、聊天访问令牌和管理令牌等非模型运行参数仍可保留在环境变量中。

## 数据结构

`models.json` 增加顶层存储版本和 `webSearch`：

```json
{
  "storageVersion": 2,
  "chat": {},
  "vision": {},
  "summary": {},
  "embedding": {},
  "image": {},
  "tts": {},
  "rerank": {},
  "webSearch": {
    "enabled": true,
    "providers": ["doubao", "tavily", "responses"],
    "maxResults": 5,
    "timeoutMs": 15000,
    "doubao": {
      "edition": "custom",
      "baseUrl": "https://open.feedcoopapi.com/search_api/web_search",
      "apiKey": "..."
    },
    "tavily": {
      "baseUrl": "https://api.tavily.com/search",
      "apiKey": "..."
    }
  }
}
```

提供方数组同时表达启用状态和回退顺序：未出现表示禁用，只出现一个表示不回退，出现多个表示按数组顺序尝试。`responses` 不保存第二把密钥，直接使用聊天模型配置；只有聊天协议为 `openai-responses` 且声明 `supportsTools=true` 时可用。

旧的 `configSource` 和 `apiKeyEnv` 字段在迁移后移除。页面保存空白密码输入框表示保持原密钥；“删除密钥”是独立的显式操作。

## 首次迁移

当 `models.json` 没有 `storageVersion: 2` 时，启动过程执行一次迁移：

1. 读取现有文件配置。
2. 按旧版优先级解析当前实际生效的模型环境变量。
3. 读取现有搜索环境变量并建立 `webSearch` 配置。
4. 原子写入完整的 `storageVersion: 2` 文件并设置权限 `0600`。
5. 后续启动只读取文件，不再读取模型或搜索环境变量。

迁移失败时不覆盖原文件，服务沿用可验证的旧配置并记录脱敏错误。部署验证成功后可从生产 `.env` 删除已经迁移的模型和搜索变量。

## 热加载

`ConfigStore` 监听 `models.json`。监听事件经过短暂防抖，避免原子替换产生重复事件。新文件必须完整通过 Schema 校验才会替换内存配置。

成功加载后：

- 重建聊天、视觉、总结、Embedding、Rerank、图片和 TTS provider；
- 重建联网搜索提供方与有序回退服务；
- 后续请求立即使用新配置；
- 记录一条不含密钥的成功日志。

JSON 无法解析或字段不合法时，继续使用上一份有效内存配置，不切换到默认配置，不中断聊天，并记录校验错误。应用关闭时释放文件监听器。

## 管理页面

保留现有 `/admin/models` 路由和“模型配置”菜单。左侧能力列表新增“联网搜索”。选中后右侧显示：

- 联网搜索总开关；
- 豆包、Tavily、Responses 的启用状态和上下移动按钮；
- 最大结果数与请求超时；
- 豆包 Custom/Global、API Key、接口地址；
- Tavily API Key、接口地址；
- Responses 当前可用性说明；
- 保存按钮和按提供方真实测试按钮。

其他模型能力继续使用当前表单，但移除“密钥环境变量”概念。API Key 留空保持不变，已配置状态只显示布尔值，页面永远收不到明文密钥。

## API 与安全

`GET /api/admin/models` 对任意层级的 `apiKey` 做递归脱敏，返回 `apiKeyConfigured`。`PUT /api/admin/models` 深度合并合法补丁、原子写盘、热重建能力并返回脱敏结果。

新增 `POST /api/admin/models/web-search/test`，请求指定 `doubao`、`tavily` 或 `responses` 以及短查询。测试使用已保存配置真实调用，返回成功状态、提供方、耗时和结果数量；错误信息经过截断和密钥脱敏。

所有管理接口继续由 `X-Admin-Token` 保护。`models.json` 权限保持 `0600`，发布包与日志不包含密钥。

## 验证

- Schema、旧配置迁移、环境变量只迁移一次、显式清除密钥和递归脱敏测试；
- 文件外部修改热加载、非法文件保持上一配置和关闭监听器测试；
- 管理 API 保存后能力与搜索同时热生效测试；
- 豆包、Tavily、Responses 单独测试接口测试；
- 管理页面搜索表单、排序、Custom/Global、密钥保持/删除和错误状态测试；
- 服务端与前端全量测试、类型检查、生产构建和 CI；
- 生产部署后检查配置迁移、删除旧环境变量、公网健康和真实联网聊天引用。

## 非目标

- 不新增独立搜索菜单或独立搜索页面；
- 不把管理令牌、端口、数据目录或代理改成模型配置；
- 不在浏览器或日志中返回任何明文密钥；
- 不改变普通聊天没有搜索意图时的调用路径。
