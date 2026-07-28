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

export const ChatModelSchema = z.object({
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
  provider: z.enum(['openai-embeddings', 'openai-compatible', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().optional(),
  model: z.string().default(''),
  /** Dimension is read from the actual model config / first response, never hardcoded globally. */
  dimensions: z.number().int().min(8).max(8192).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  maxRetries: z.number().int().min(0).max(5).default(2)
});
export type EmbeddingModelConfig = z.infer<typeof EmbeddingModelSchema>;

export const ImageModelSchema = z.object({
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
  provider: z.enum(['openai-tts', 'openai-compatible', 'none']).default('none'),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  apiKeyEnv: z.string().optional(),
  model: z.string().default(''),
  voice: z.string().default('alloy'),
  format: z.enum(['mp3', 'wav', 'opus', 'aac', 'flac']).default('mp3'),
  speed: z.number().min(0.25).max(4).default(1),
  timeoutMs: z.number().int().min(1000).max(300_000).default(90_000),
  maxRetries: z.number().int().min(0).max(5).default(1)
});
export type TtsModelConfig = z.infer<typeof TtsModelSchema>;

export const SttModelSchema = z.object({
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

export const ModelsConfigSchema = z.object({
  chat: ChatModelSchema.default({}),
  /** Optional dedicated models; when omitted they fall back to `chat`. */
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
