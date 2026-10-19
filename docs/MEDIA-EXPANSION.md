# 媒体链路（图片 / 视频 / 语音）

主模型只表达**意图**，并且只通过工具表达；提示词在本地同步拼出来，不再经过任何"导演"模型。

```text
主模型          调用 send_image / send_video / send_voice，参数只写意图
  ↓
media-tools     暂存这条回复的意图（core/media-tools/stage.ts）
  ↓
本地拼装        意图 + media-prompt-spec.json 词表 + 视觉时间光线（core/mediaDirector.ts）
  ↓
Provider        真正生成（providers/image.ts / providers/video.ts / TTS）
```

## 媒体只走工具

- 图片、视频、语音只有两个来源：用户自己明确要（`parseUserDirectives` / `parseVoiceIntent`），
  或这条回复调用了 `send_image` / `send_video` / `send_voice`。
- 旧的文本标记 `[[image]]`、`[[video]]`、`[[voice]]`、`[[voice-only]]`、`[[image-self]]`、
  `[[video-self]]` 及中文别名已退役：仍会从可见文本里剥掉，但不触发任何东西。被网关压平成文本的
  伪工具调用（`<tool_call>…`）也一样，只剥离、记一条 `flattened_tool_call`，从不执行。
- 表情包仍然用 `[[sticker:…]]` / `[[sticker-only:…]]` 标记，它不是工具。
- 她不发自己的形象：没有参考图、没有穿搭连续性，"来张自拍"这类请求也不会被兜底成一张图。
- 主动消息只发文字。

## 拼装规则

`core/mediaDirector.ts`

- **图片**：`意图 → 场景词（可选）→ style → Avoid → Never`，新图再追加视觉时间约束
  （`applyVisualTimeToPrompt`）；编辑用户发来的图时只用意图本身。
- **视频**：`意图 → style → camera → Avoid → Never`，同样追加视觉时间约束；时长取规范里的最小值。
- **语音**：脚本就是她的正文，FishCueRenderer 只加节奏 cue；情绪来自 `send_voice` 的 `emotion`。

## 可配置部分：`CONFIG_DIR/media-prompt-spec.json`

首次启动时写入默认值，改动后**热加载**，非法内容保留上一份有效配置；发布包不包含该文件，升级不会覆盖。
想换风格词直接改这个文件即可，不用碰代码。

```jsonc
{
  "version": 1,
  "image": {
    "style": ["soft natural lighting, warm tones", "natural composition, eye-level framing"],
    "avoid": ["plastic skin", "over-smoothed retouching", "..."],
    "scenes": { "daily_life": { "suffix": "candid photo, natural daily life scene", "camera": "eye level" } }
  },
  "video": {
    "style": ["single continuous shot", "physically plausible motion and lighting"],
    "camera": ["gentle handheld drift", "slow push in", "locked-off tripod shot"],
    "avoid": ["fast cuts", "transitions", "captions or subtitles", "..."],
    "durationSec": { "min": 4, "max": 10 }
  },
  "boundaries": { "disallowed": ["nudity", "explicit sexual content", "..."] }
}
```

省略的字段回落到默认值，所以只写想改的那部分就够了。

## 相关文件

| 路径 | 内容 |
| --- | --- |
| `core/media-tools/tools.ts` | 三个媒体工具的描述与参数 |
| `core/media-tools/stage.ts` | 每条回复的媒体意图暂存与合并 |
| `core/mediaDirector.ts` | 本地提示词拼装 |
| `config/media-spec.ts` | 规范的 schema、默认值与热加载 |
| `core/visual-time.ts` | 视觉时间与光线约束 |
| `core/directives.ts` | 用户意图解析；剥离退役标记 |
