import type { ChatProvider } from '../providers/types.js';
import type { ConfigStore } from '../config/store.js';
import { FISH_ALIAS_CUE, FISH_MOOD_TABLE } from './voice/fishCue.js';
import type { VoiceDeliveryPlan } from './voice/types.js';

/**
 * Media Prompt Director (SOOYA-Media-Prompt-Director.md).
 *
 * The main model decides WHAT to express; two fixed prompts decide HOW to hand
 * it to Fish / Image2. No second model: the existing chat provider is called
 * once more with a fixed system prompt, and the reply is parsed as JSON.
 *
 * Voice:  intent {content, emotion, intensity} → {text, speed}
 * Image:  intent {scene, action, mood, intent} → {prompt, aspectRatio}
 *
 * Both outputs are validated here: JSON that does not parse, a cue outside the
 * whitelist, or an empty text falls back to the input rather than failing the
 * request — quality is a bonus, correctness is a guarantee.
 */

const VOICE_DIRECTOR_PROMPT = `你是 SOOYA 的语音提示词整理器。

SOOYA 已经拥有固定的 Fish Voice ID。
你不负责改变她的音色。

你的任务：
把输入内容整理成适合 Fish S2 系列生成自然私人聊天语音的最终文本。

目标：
- 自然
- 像真人手机语音
- 私聊感
- 不像播音
- 不像配音
- 不过度表演

规则：

1. 保留原意。
2. 将书面表达改成自然口语。
3. 优先使用短句。
4. 用标点制造自然停顿。
5. 普通语句默认不加 cue。
6. 只有明显能提升表达时才加入 Fish cue。
7. Fish cue 使用 [方括号自然语言描述]。
8. 一条普通短语音最多 0～1 个主要 cue。
9. 不要堆叠多个强情绪。
10. 不要为了真人感强行添加大量“嗯、唔、那个”。
11. 不要加入原本不存在的重要事实。
12. 不要输出解释。

常用 cue 示例：
- [speaking softly]
- [slightly shy]
- [small chuckle]
- [slightly sleepy]
- [gently reassuring]
- [warm and relaxed]

语速建议：
- 普通：0.98～1.02
- 温柔：0.96～0.99
- 困倦：0.94～0.98
- 开心：1.00～1.05

输出 JSON：

{
  "text": "最终送给 Fish 的文本",
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

/** Cues the director may emit; anything else is stripped (whitelist fallback). */
const ALLOWED_FISH_CUES = new Set([
  '[speaking softly]',
  '[slightly shy]',
  '[small chuckle]',
  '[slightly sleepy]',
  '[gently reassuring]',
  '[warm and relaxed]'
]);

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
   * Voice director: intent → Fish-ready {text, speed}.
   * Falls back to the raw content when the model cannot produce a usable JSON.
   */
  async voice(intent: VoiceDirectorIntent, opts: { signal?: AbortSignal; mode?: string; userText?: string; reportReasons?: string[]; maxSeconds?: number } = {}): Promise<VoiceDirectorResult> {
    const contextLines = [
      `【用户这轮说的话】\n${(opts.userText || '（用户这轮没有发文字）').slice(0, 1500)}`,
      `【语音模式】${opts.mode ?? '语音消息'}`,
      ...(opts.maxSeconds ? [`时长上限约 ${opts.maxSeconds} 秒（中文约每秒 4-5 字）。`] : []),
      ...(opts.reportReasons?.length ? [`上一版没有通过检查，原因：${opts.reportReasons.join('；')}。请针对这些问题重写。`] : [])
    ];
    const raw = await this.complete(
      `${contextLines.join('\n')}\n\n请把下面的语音意图整理成 Fish 最终文本：\n\n${JSON.stringify(intent, null, 2)}\n\n只输出 JSON，不要解释。`,
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

/**
 * Strips bracket cues not on the whitelist from the director's output. The
 * director is a language model, so the whitelist is the final authority —
 * "no cue > wrong cue".
 */
export function sanitizeFishText(text: string): string {
  const cueMatch = /^(\[[^\]]+\])\s*(.+)$/s.exec(text.trim());
  if (!cueMatch) return text.trim();
  const [cue, rest] = [cueMatch[1]!, cueMatch[2]!];
  if (ALLOWED_FISH_CUES.has(cue)) return text.trim();
  return rest.trim();
}

/**
 * Allowed cues for validation helpers: the whitelist union of the domain table
 * and the alias table, so tests can assert against one source of truth.
 */
export function allowedFishCues(): string[] {
  const cues = new Set<string>();
  for (const spec of Object.values(FISH_MOOD_TABLE)) if (spec.cue) cues.add(spec.cue);
  for (const spec of Object.values(FISH_ALIAS_CUE)) if (spec.cue) cues.add(spec.cue);
  return [...cues];
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
