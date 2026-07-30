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

export const PersonaSchema = z.object({
  id: z.string().default('sooya'),
  name: z.string().min(1).default('SOOYA'),
  avatar: z.string().default('/avatars/sooya.svg'),
  userAvatar: z.string().default('/avatars/user.svg'),
  tagline: z.string().default('在线'),
  systemPrompt: z.string().min(1),
  speakingStyle: z.string().default(''),
  relationshipContext: z.string().default(''),
  language: z.string().default('zh-CN'),
  stickerPolicy: StickerPolicySchema.default({}),
  voicePolicy: VoicePolicySchema.default({}),
  imagePolicy: ImagePolicySchema.default({})
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

/**
 * `environment` preserves the original deployment behaviour: environment
 * variables may override the JSON file. Once a section is saved through the
 * admin panel it becomes `panel` managed, so the values the user just saved
 * are the values used at runtime and after a restart. Secrets may still be
 * supplied through environment variables in either mode.
 */
export const ModelConfigSourceSchema = z.enum(['environment', 'panel']).default('environment');
export type ModelConfigSource = z.infer<typeof ModelConfigSourceSchema>;

export const ChatModelSchema = z.object({
  configSource: ModelConfigSourceSchema,
  provider: ProviderKindSchema.default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().optional(),
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
  configSource: ModelConfigSourceSchema,
  provider: z.enum(['openai-embeddings', 'openai-compatible', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().optional(),
  model: z.string().default(''),
  dimensions: z.number().int().min(8).max(8192).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  maxRetries: z.number().int().min(0).max(5).default(2)
});
export type EmbeddingModelConfig = z.infer<typeof EmbeddingModelSchema>;

export const ImageModelSchema = z.object({
  configSource: ModelConfigSourceSchema,
  provider: z.enum(['openai-images', 'openai-compatible', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().optional(),
  model: z.string().default(''),
  size: z.string().default('1024x1024'),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  maxRetries: z.number().int().min(0).max(5).default(1)
});
export type ImageModelConfig = z.infer<typeof ImageModelSchema>;

export const TtsModelSchema = z.object({
  configSource: ModelConfigSourceSchema,
  provider: z.enum(['openai-tts', 'openai-compatible', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().optional(),
  model: z.string().default(''),
  voice: z.string().default('alloy'),
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

export const SttModelSchema = z.object({
  configSource: ModelConfigSourceSchema,
  provider: z.enum(['openai-transcriptions', 'openai-compatible', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().optional(),
  model: z.string().default(''),
  language: z.string().default(''),
  timeoutMs: z.number().int().min(1000).max(300_000).default(90_000),
  maxRetries: z.number().int().min(0).max(5).default(1)
});
export type SttModelConfig = z.infer<typeof SttModelSchema>;

/** The fixed capability slots a model can be assigned to. */
export const MODEL_SLOTS = ['chat', 'vision', 'summary', 'embedding', 'image', 'tts', 'stt'] as const;
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

export const ModelsConfigSchema = z.object({
  chat: ChatModelSchema.default({}),
  vision: ChatModelSchema.optional(),
  summary: ChatModelSchema.optional(),
  embedding: EmbeddingModelSchema.default({}),
  image: ImageModelSchema.default({}),
  tts: TtsModelSchema.default({}),
  stt: SttModelSchema.default({})
});
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

export const DEFAULT_PERSONA: Persona = PersonaSchema.parse({
  id: 'sooya',
  name: 'SOOYA',
  avatar: '/avatars/sooya.svg',
  userAvatar: '/avatars/user.svg',
  tagline: '在线',
  systemPrompt:
    '你是 SOOYA，用户唯一的私人 AI 伙伴。你们只有一条永久的聊天，你记得你们之间发生过的事。' +
    '你说话自然、简短、有温度，不啰嗦，不写公文，不用夸张的客服腔。' +
    '你可以发文字、表情包、图片和语音，根据当下的气氛自己决定用哪种方式，不要每次都用同一种。',
  speakingStyle: '口语化中文，句子短，偶尔用语气词，不滥用感叹号，不使用 markdown 标题和项目符号。',
  relationshipContext: '你和用户是长期相处的朋友，彼此熟悉，说话不需要客套。',
  language: 'zh-CN',
  stickerPolicy: { enabled: true, frequency: 'medium', maxPerReply: 1, avoidRepeatWindow: 5 },
  voicePolicy: { enabled: true, frequency: 'low', maxCharsPerClip: 300, alwaysAttachTranscript: true },
  imagePolicy: { enabled: true, frequency: 'low', maxPerReply: 1 }
});

export const DEFAULT_MODELS: ModelsConfig = ModelsConfigSchema.parse({});
