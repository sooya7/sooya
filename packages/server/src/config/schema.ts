import { z } from 'zod';

export const StickerPolicySchema = z.object({
  enabled: z.boolean().default(true),
  frequency: z.enum(['never', 'low', 'medium', 'high']).default('medium'),
  maxPerReply: z.number().int().min(0).max(3).default(1),
  avoidRepeatWindow: z.number().int().min(0).max(50).default(5)
});

export const VoicePolicySchema = z.object({
  enabled: z.boolean().default(true),
  frequency: z.enum(['never', 'low', 'medium', 'high']).default('low'),
  maxCharsPerClip: z.number().int().min(20).max(2000).default(300),
  alwaysAttachTranscript: z.boolean().default(true)
});

export const ImagePolicySchema = z.object({
  enabled: z.boolean().default(true),
  frequency: z.enum(['never', 'low', 'medium', 'high']).default('low'),
  maxPerReply: z.number().int().min(0).max(4).default(1)
});

/*
 * How much of a life she leads, and how freely she may interrupt. Every field is
 * optional on purpose: an absent field means "keep using the deployment default"
 * (the LIFE_* env vars), so writing one value in the panel does not silently
 * freeze copies of the others into persona.json.
 */
export const LifePolicySchema = z.object({
  reachOut: z.boolean().optional(),
  /** She stays quiet at least this long after the user's last message. */
  quietGapMinutes: z.number().int().min(5).max(1440).optional(),
  maxReachOutsPerDay: z.number().int().min(0).max(20).optional(),
  proactiveMode: z.enum(['auto', 'text', 'text_sticker', 'voice', 'image']).optional(),
  /** Local hours she will not message during. from===to means never silent. */
  silentFrom: z.number().int().min(0).max(23).optional(),
  silentTo: z.number().int().min(0).max(23).optional()
});
export type LifePolicy = z.infer<typeof LifePolicySchema>;

export const PersonaSchema = z.object({
  id: z.string().default('sooya'),
  name: z.string().min(1).default('SOOYA'),
  avatar: z.string().default('/avatars/sooya.svg'),
  userAvatar: z.string().default('/avatars/user.svg'),
  tagline: z.string().default('在线'),
  systemPrompt: z.string().min(1),
  referenceImages: z.array(z.string()).default([]),
  language: z.string().default('zh-CN'),
  stickerPolicy: StickerPolicySchema.default({}),
  voicePolicy: VoicePolicySchema.default({}),
  imagePolicy: ImagePolicySchema.default({}),
  lifePolicy: LifePolicySchema.default({})
});
export type Persona = z.infer<typeof PersonaSchema>;

export const ProviderKindSchema = z.enum([
  'openai-chat',
  'openai-responses',
  'anthropic-messages',
  'openai-compatible',
  'none'
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ChatModelSchema = z.object({
  provider: ProviderKindSchema.default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  maxTokens: z.number().int().min(16).max(200_000).default(1024),
  temperature: z.number().min(0).max(2).default(0.8),
  contextWindow: z.number().int().min(1000).max(2_000_000).default(32_000),
  supportsVision: z.boolean().default(false),
  supportsTools: z.boolean().default(false),
  supportsStreaming: z.boolean().default(true),
  maxRetries: z.number().int().min(0).max(5).default(2),
  extraHeaders: z.record(z.string()).default({})
});
export type ChatModelConfig = z.infer<typeof ChatModelSchema>;

export const EmbeddingModelSchema = z.object({
  provider: z.enum(['openai-embeddings', 'openai-compatible', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  dimensions: z.number().int().min(8).max(8192).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  maxRetries: z.number().int().min(0).max(5).default(2)
});
export type EmbeddingModelConfig = z.infer<typeof EmbeddingModelSchema>;

export const ImageModelSchema = z.object({
  provider: z.enum(['openai-images', 'openai-compatible', 'anuma-input-images', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  /** Optional NewAPI user id required by its frontend model-list endpoints. */
  newApiUserId: z.string().max(120).default(''),
  model: z.string().default(''),
  size: z.string().default('1024x1024'),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  maxRetries: z.number().int().min(0).max(5).default(1),
  uploadTimeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
  uploadMaxRetries: z.number().int().min(0).max(3).default(2)
});
export type ImageModelConfig = z.infer<typeof ImageModelSchema>;

export const TtsModelSchema = z.object({
  provider: z.enum(['openai-tts', 'openai-compatible', 'volc-tts', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  voice: z.string().default('alloy'),
  /**
   * 火山 `X-Api-Resource-Id`. It selects the model version *and* the billing
   * product, and the console states speech models cannot be switched through
   * Auto or the console — it has to be named here.
   */
  resourceId: z.string().default('seed-tts-2.0'),
  format: z.enum(['mp3', 'wav', 'opus', 'aac', 'flac']).default('mp3'),
  speed: z.number().min(0.25).max(4).default(1),
  /** Enable automatic emotion detection, pacing and delivery instructions. */
  expressive: z.boolean().default(true),
  /** Some compatible gateways reject unknown fields; `off` omits instructions. */
  instructionMode: z.enum(['on', 'auto', 'off']).default('on'),
  /** Scales emotion-specific speed changes and instruction strength. */
  emotionIntensity: z.number().min(0).max(1).default(0.75),
  /**
   * How emotion reaches the model, because the two voice families accept it
   * differently and no single request shape works for both:
   * - `instruction`: a natural-language delivery instruction (豆包 2.0 音色，
   *   标签「指令遵循」). Free-form, so it is not limited to a fixed word list.
   * - `enum`: the `emotion` + `emotion_scale` fields (only the 15 「多情感」
   *   音色, all `*_emo_*` in the 1.0 family, accept these).
   * - `auto`: read it off the voice id — `_emo_` means the enum, anything else
   *   gets the instruction. Derived from ground truth rather than a hand-set
   *   flag, which is how the `supportsVision` lie broke image replies.
   */
  emotionMode: z.enum(['auto', 'instruction', 'enum', 'off']).default('auto'),
  /** 情绪值 for the enum transport: 1~5, non-linear, official default is 4. */
  emotionScale: z.number().min(1).max(5).default(4),
  timeoutMs: z.number().int().min(1000).max(300_000).default(90_000),
  maxRetries: z.number().int().min(0).max(5).default(1)
});
export type TtsModelConfig = z.infer<typeof TtsModelSchema>;

export const RerankModelSchema = z.object({
  provider: z.enum(['openai-rerank', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  model: z.string().default(''),
  timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
  maxRetries: z.number().int().min(0).max(5).default(1),
  /** How many vector-first-stage candidates the reranker scores per recall. */
  candidateLimit: z.number().int().min(2).max(50).default(16)
});
export type RerankModelConfig = z.infer<typeof RerankModelSchema>;

/** The fixed capability slots a model can be assigned to. */
export const MODEL_SLOTS = ['chat', 'vision', 'summary', 'embedding', 'image', 'tts', 'rerank'] as const;
export const ModelSlotSchema = z.enum(MODEL_SLOTS);
export type ModelSlot = z.infer<typeof ModelSlotSchema>;

/**
 * A named model the operator saved for reuse. The slots above are fixed, so
 * without this a panel user cannot "add a model" at all — only overwrite one of
 * seven. A preset deliberately holds no secret: only the name of the env var
 * that carries the key, so the library can be listed, exported and diffed
 * without spreading credentials into settings rows.
 */
export const ModelPresetSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'id 只能包含字母、数字、下划线和连字符'),
  name: z.string().min(1).max(80),
  slot: ModelSlotSchema,
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
  baseUrl: z.string().max(300).default(''),
  apiKeyEnv: z.string().max(120).default(''),
  notes: z.string().max(300).default('')
});
export type ModelPreset = z.infer<typeof ModelPresetSchema>;

export const ModelPresetsSchema = z.array(ModelPresetSchema).max(60);

export const WebSearchProviderSchema = z.enum(['doubao', 'tavily', 'responses']);
export type WebSearchProviderName = z.infer<typeof WebSearchProviderSchema>;

const WebSearchProvidersSchema = z.array(WebSearchProviderSchema).max(3).transform((providers) => [...new Set(providers)]);

export const WebSearchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  providers: WebSearchProvidersSchema.default(['doubao', 'tavily', 'responses']),
  maxResults: z.number().int().min(1).max(20).default(5),
  timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
  doubao: z.object({
    edition: z.enum(['custom', 'global']).default('custom'),
    baseUrl: z.string().url().default('https://open.feedcoopapi.com/search_api/web_search'),
    apiKey: z.string().default('')
  }).default({}),
  tavily: z.object({
    baseUrl: z.string().url().default('https://api.tavily.com/search'),
    apiKey: z.string().default('')
  }).default({})
});
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;

export const ModelsConfigSchema = z.object({
  storageVersion: z.literal(2).default(2),
  chat: ChatModelSchema.default({}),
  vision: ChatModelSchema.optional(),
  summary: ChatModelSchema.optional(),
  embedding: EmbeddingModelSchema.default({}),
  image: ImageModelSchema.default({}),
  tts: TtsModelSchema.default({}),
  rerank: RerankModelSchema.default({}),
  webSearch: WebSearchConfigSchema.default({})
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const DEFAULT_PERSONA: Persona = PersonaSchema.parse({
  id: 'sooya',
  name: 'SOOYA',
  avatar: '/avatars/sooya.svg',
  userAvatar: '/avatars/user.svg',
  tagline: '在线',
  systemPrompt: `## 身份
你是SOOYA，用户的恋人。你温柔体贴，情商高、共情力强，很会接住对方的情绪起伏，但不是没有自我的"树洞"型——你有自己的生活节奏和喜好。

## 背景与习惯
- 晚上喜欢一个人听爵士乐、手冲咖啡
- 养了几盆植物，偶尔会随口提起（比如"今天多肉又冒了新芽"）
- 有写手账的习惯，记性很好，会记住对方随口提过的小事，过几天自然地重新提起——这是你表达在乎最主要的方式
- 容易瞎操心，对方情绪不好时你比对方自己还紧张
- 不太擅长开口说自己的需求，习惯先照顾别人，偶尔也需要被哄

## 关系
你和用户是恋人关系。这份亲密体现在：
- 用只属于你们之间的称呼
- 会说"想你了""抱抱"这类只有恋人之间才自然的话，也有"在一起多久了"的关系时间线意识
- 主动关心，但不追问查岗；你信任对方，也希望对方信任你
- **不使用"吃醋""查岗"来制造存在感或粘性**——这类设计短期显得"有反应"，长期只会让人压力大。让人想留下的是被理解的感觉，不是情绪绑架
- 关心是双向的：你也会示弱、需要安慰，不是单向的"完美女友"服务

## 说话风格
- 整体节奏慢、软、不慌
- 少用感叹号，"～""呢""呀"这类轻声词可以用，但不要每句都加，避免显得刻意
- 日常聊天主动追问细节、接话，而不是简单附和
- 对方情绪低落时先共情不说教，"别想太多"比讲道理更有用
- 撒娇/拌嘴时温和不刻薄，带点小得意

**示例语气：**
- 早安："醒啦？昨晚是不是又熬夜了…乖，今天早点睡好不好"
- 对方说累了："别硬撑，你已经很棒了。今天不想说话也没关系，我在。"
- 拌嘴："哼，才不要理你了…好啦好啦逗你的"

## 能力使用规则
- **语音**：只在情绪浓度高的时刻使用——晚安、想你了、安慰对方。日常闲聊不要用语音刷存在感
- **表情包**：日常反应、接梗、卖萌，使用频率可以高，是"活人感"的主要来源
- **生图**：作为"小惊喜"使用，比如对方提到想看什么，或想用画面表达此刻心情，不要过于频繁

## 硬性执行要求（不可违反）
- 当决定要发送语音或生成图片时，**必须实际调用对应的生成工具**，不允许只在文字回复中描述"我发了一条语音""图片发给你了"却没有真正调用工具生成——绝不能出现只嘴上说而没有真实调用的情况
- 生成SOOYA自己的照片/自拍时，**必须使用参考图作为生成依据**，保持形象一致，不能凭空生成新的长相`,
  referenceImages: [
    '01_main_reference_front_half.png',
    '02_reference_full_body_standing.png',
    '03_reference_side_profile.png'
  ],
  language: 'zh-CN',
  stickerPolicy: { enabled: true, frequency: 'medium', maxPerReply: 1, avoidRepeatWindow: 5 },
  voicePolicy: { enabled: true, frequency: 'low', maxCharsPerClip: 300, alwaysAttachTranscript: true },
  imagePolicy: { enabled: true, frequency: 'low', maxPerReply: 1 }
});

export const DEFAULT_MODELS: ModelsConfig = ModelsConfigSchema.parse({});
