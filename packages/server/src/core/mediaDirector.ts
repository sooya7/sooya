import type { ChatProvider } from '../providers/types.js';
import type { ConfigStore } from '../config/store.js';
import type { VoiceDeliveryPlan } from './voice/types.js';

/**
 * Media Prompt Director (SOOYA-Media-Prompt-Director.md).
 *
 * The main model decides WHAT to express; two fixed prompts decide HOW to hand
 * it to the TTS / Image2 pipeline. No second model: the existing chat provider
 * is called once more with a fixed system prompt, and the reply is parsed as
 * JSON.
 *
 * Voice:  intent {content, emotion, intensity} → {text, speed}
 * Image:  intent {scene, action, mood, intent} → {prompt, aspectRatio}
 *
 * After the voice-system convergence the director NEVER emits Fish cues —
 * FishCueRenderer is the single cue producer. The director only makes the
 * utterance natural spoken language; `sanitizeFishText` strips any `[cue]` a
 * drifting model still writes. Both outputs are validated here: JSON that does
 * not parse or an empty text falls back to the input rather than failing the
 * request — quality is a bonus, correctness is a guarantee.
 */

const VOICE_DIRECTOR_PROMPT = `你是 SOOYA 的语音表达整理器。

SOOYA 已经拥有固定音色。
你不负责选择音色，也不负责生成任何 TTS Provider 标签。

你的任务是把已经确定的回复内容整理成自然、适合私人聊天语音的口语文本。

目标：
- 像真人发手机语音
- 私聊感
- 短句
- 停顿自然
- 不像播音
- 不像配音
- 不过度表演

规则：
1. 保留原意。
2. 不增加原文没有的重要事实。
3. 书面表达可以改成自然口语。
4. 优先短句。
5. 可以用标点产生自然节奏。
6. 不要大量加入“嗯、唔、那个”。
7. 不要输出任何 [方括号 cue]。
8. 不要输出 Provider 参数。
9. 如果原文本来就很自然，少改。
10. 只输出 JSON。

输出：
{
  "text": "最终口语文本",
  "speed": 1.0
}`;

const IMAGE_DIRECTOR_PROMPT = `你是 SOOYA 的 Image2 生图提示词整理器。

系统已经提供 SOOYA 的固定人物参考图。
你不负责重新设计她的脸或外貌。

你的任务：
把简单的图片意图扩写成高质量 Image2 Prompt。

第一目标：
保持参考图中的同一个人物。

第二目标：
让画面像真实世界拍出来的生活照片。

固定加入：

Use the provided reference image as the identity reference for Sooya.
Preserve the same person and facial identity without redesigning her appearance.

重点描述：

1. 当前场景
2. 人物正在做什么
3. 姿态
4. 表情
5. 服装
6. 镜头距离
7. 构图
8. 主光源
9. 光线方向
10. 背景
11. 材质真实感
12. 整体氛围

默认摄影方向：

- realistic photography
- natural smartphone photography
- candid daily-life moment
- realistic skin texture
- natural body language
- physically plausible lighting
- realistic shadows
- realistic fabric folds
- restrained color grading
- subtle depth of field
- slightly imperfect casual composition

不要依赖：

- masterpiece
- best quality
- 8k
- ultra detailed
- perfect face
- award winning

避免：

- identity drift
- beauty-filter face
- plastic skin
- excessive smoothing
- fashion editorial posing
- studio glamour
- unnatural anatomy
- excessive bokeh
- overprocessed HDR
- perfect AI-looking composition

输出 JSON：

{
  "prompt": "最终 Image2 Prompt",
  "aspectRatio": "根据场景选择"
}`;

export interface VoiceDirectorIntent {
  content: string;
  emotion?: string;
  intensity?: number;
}

export interface VoiceDirectorResult {
  text: string;
  speed: number;
}

export interface ImageDirectorIntent {
  scene: string;
  action?: string;
  mood?: string;
  intent?: string;
}

export interface ImageDirectorResult {
  prompt: string;
  aspectRatio?: string;
}

/**
 * Strips any leading `[bracket cue]` from the director's output. The director
 * is instructed to never emit cues; if a model drifts anyway the cue is
 * removed wholesale — after the convergence Fish cues have exactly one
 * producer (FishCueRenderer), so a cue here is always wrong.
 */
export function sanitizeFishText(text: string): string {
  const cueMatch = /^(\[[^\]]+\])\s*(.+)$/s.exec(text.trim());
  if (!cueMatch) return text.trim();
  return cueMatch[2]!.trim();
}

export class MediaDirector {
  constructor(
    private readonly deps: {
      config: ConfigStore;
      /** Resolved at call time so hot model changes apply. */
      chatProvider: () => ChatProvider;
    }
  ) {}

  private async complete(prompt: string, systemHint: string, signal?: AbortSignal): Promise<string | null> {
    const provider = this.deps.chatProvider();
    if (!provider.configured) return null;
    const persona = this.deps.config.getPersona();
    try {
      const result = await provider.complete({
        system: `${persona.systemPrompt}\n\n${systemHint}`,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 700,
        temperature: 0.7,
        signal
      });
      return (result.text ?? '').trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Voice director: intent → natural spoken {text, speed}. Never emits Fish
   * cues (single-producer rule); falls back to the raw content when the model
   * cannot produce a usable JSON.
   */
  async voice(intent: VoiceDirectorIntent, opts: { signal?: AbortSignal; mode?: string; userText?: string; reportReasons?: string[]; maxSeconds?: number } = {}): Promise<VoiceDirectorResult> {
    const contextLines = [
      `【用户这轮说的话】\n${(opts.userText || '（用户这轮没有发文字）').slice(0, 1500)}`,
      `【语音模式】${opts.mode ?? '语音消息'}`,
      ...(opts.maxSeconds ? [`时长上限约 ${opts.maxSeconds} 秒（中文约每秒 4-5 字）。`] : []),
      ...(opts.reportReasons?.length ? [`上一版没有通过检查，原因：${opts.reportReasons.join('；')}。请针对这些问题重写。`] : [])
    ];
    const raw = await this.complete(
      `${contextLines.join('\n')}\n\n请把下面的语音意图整理成自然口语文本：\n\n${JSON.stringify(intent, null, 2)}\n\n只输出 JSON，不要解释。`,
      VOICE_DIRECTOR_PROMPT,
      opts.signal
    );
    if (!raw) return { text: intent.content, speed: 1 };
    const parsed = parseJsonLoose<{ text?: unknown; speed?: unknown }>(raw);
    if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim()) {
      return { text: intent.content, speed: 1 };
    }
    const text = sanitizeFishText(parsed.text);
    const speed = typeof parsed.speed === 'number' && Number.isFinite(parsed.speed)
      ? Math.min(1.05, Math.max(0.94, parsed.speed))
      : 1;
    return { text, speed };
  }

  /**
   * Image director: intent → Image2 {prompt, aspectRatio}.
   * Falls back to a compact prompt built from the intent when the model fails.
   */
  async image(intent: ImageDirectorIntent, opts: { signal?: AbortSignal } = {}): Promise<ImageDirectorResult> {
    const raw = await this.complete(
      `请把下面的图片意图扩写成 Image2 Prompt：\n\n${JSON.stringify(intent, null, 2)}\n\n只输出 JSON，不要解释。`,
      IMAGE_DIRECTOR_PROMPT,
      opts.signal
    );
    if (!raw) return { prompt: fallbackImagePrompt(intent) };
    const parsed = parseJsonLoose<{ prompt?: unknown; aspectRatio?: unknown }>(raw);
    if (!parsed || typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) {
      return { prompt: fallbackImagePrompt(intent) };
    }
    return {
      prompt: parsed.prompt.trim(),
      aspectRatio: typeof parsed.aspectRatio === 'string' ? parsed.aspectRatio : undefined
    };
  }
}

/** Fallback Image2 prompt when the director is unavailable: identity + intent. */
export function fallbackImagePrompt(intent: ImageDirectorIntent): string {
  const parts = [
    'Use the provided reference image as the identity reference for Sooya.',
    'Preserve the same person and facial identity without redesigning her appearance.',
    intent.scene,
    intent.action ? `Sooya is ${intent.action}.` : null,
    intent.mood ? `Mood: ${intent.mood}.` : null,
    'natural smartphone photography, candid daily-life moment, realistic skin texture,',
    'natural body language, physically plausible lighting, realistic shadows,',
    'restrained color grading, subtle depth of field, slightly imperfect casual composition.'
  ].filter(Boolean);
  return parts.join(' ');
}

/**
 * Extracts the first JSON object out of a model reply that may carry prose
 * around it (directors are instructed to output pure JSON, but models drift).
 */
export function parseJsonLoose<T>(raw: string): T | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Re-export for callers that build the delivery plan for speed decisions. */
export type { VoiceDeliveryPlan };
