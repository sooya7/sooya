import { z } from 'zod';
import type { DecisionModelConfig } from '../config/schema.js';
import type { ModelDirectives, UserDirectives } from './directives.js';
import { safeFetch, type SafeFetchOptions } from '../util/http.js';

/** Includes DNS lookup in the deadline, and cancels superseded generations promptly. */
async function requestDecision(url: string, options: SafeFetchOptions) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(new Error('decision timeout')), options.timeoutMs);
  try {
    return await Promise.race([
      safeFetch(url, { ...options, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      })
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

const probability = z.number().finite().min(0).max(1);
const answer = z.object({ type: z.literal('noul'), noul: probability });
const responseSchema = z.object({ answers: z.object({ memory: answer, image: answer, video: answer, voice: answer }) });
export interface BehaviorDecision {
  status: 'ok' | 'disabled' | 'skipped' | 'unconfigured' | 'unavailable';
  memory: 'save' | 'review' | 'skip';
  media: Partial<Record<'image' | 'video' | 'voice', boolean>>;
  probabilities?: Record<'memory' | 'image' | 'video' | 'voice', number>;
}

export function explicitMemoryIntent(text: string): 'save' | 'skip' | undefined {
  if (/(?:不要|别|不用|无需)(?:再|把.{0,30})?(?:记住|记下|记录|保存)|不(?:要|用)存入记忆|do not (?:remember|save)|don't (?:remember|save)/i.test(text)) return 'skip';
  if (/(?:^|[。！？\n，,])\s*(?:(?:请|帮我|给我|一定要|以后要|以后)\s*)?(?:记住|记下来|保存到(?:长期)?记忆|remember (?:this|that)|save (?:this|that) to memory)/i.test(text)) return 'save';
  return undefined;
}

export function decisionEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid decision endpoint');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/systemone') ? path : `${path.endsWith('/v1') ? path : `${path}/v1`}/systemone`;
  return url.toString();
}

/** One bounded request per reply batch. No conversation text or credentials in diagnostics. */
export class BehaviorDecisionService {
  constructor(private readonly config: () => DecisionModelConfig) {}

  async evaluate(userText: string, recentContext = '', signal?: AbortSignal, test = false): Promise<BehaviorDecision> {
    const config = this.config();
    const memory = explicitMemoryIntent(userText) ?? 'review';
    const fallback = (status: BehaviorDecision['status']): BehaviorDecision => ({ status, memory, media: {} });
    if (!config.enabled && !test) return { status: 'disabled', memory: 'review', media: {} };
    // Image-only or sticker-only turns carry nothing to judge; keep the original flow.
    if (!userText.trim()) return { status: 'skipped', memory: 'review', media: {} };
    if (!config.baseUrl.trim() || !config.apiKey.trim()) return fallback('unconfigured');
    signal?.throwIfAborted();
    try {
      const { response, body } = await requestDecision(decisionEndpoint(config.baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        timeoutMs: config.timeoutMs, maxBytes: 64 * 1024, signal,
        body: JSON.stringify({
          model: config.model,
          state: { currentUserMessage: userText.slice(0, 12000), recentConversation: recentContext.slice(-6000) },
          questions: {
            memory: { type: 'noul', instructions: '当前用户消息是否包含值得长期记忆的稳定偏好、个人事实、明确决定或长期约定？忽略寒暄、玩笑、临时信息、引用示例和助手自己的猜测。用户说不要记忆时选否。上下文仅用于消歧，不能把历史内容当作本轮新事实。' },
            image: { type: 'noul', instructions: '根据当前请求和上下文，这次回复是否需要生成一张新图片或示意图？包括明确要求和明显能帮助表达的场景；讨论已有图片、读图、提到图片格式不等于需要生图。用户禁止图片时选否。' },
            video: { type: 'noul', instructions: '这次回复是否需要生成新视频？视频耗时且成本高，仅在明确请求或动态演示确有必要时选是。讨论已有视频、链接或视频知识不等于生成视频。用户禁止视频时选否。' },
            voice: { type: 'noul', instructions: '这次回复是否适合附带语音？明确要求语音、希望听讲或简短情绪陪伴可选是；代码、表格、复杂操作通常应使用文字。提到语音技术不等于要求语音。用户要求纯文字或禁止语音时选否。' }
          }
        })
      });
      if (!response.ok) return fallback('unavailable');
      const parsed = responseSchema.safeParse(JSON.parse(body.toString('utf8')));
      if (!parsed.success) return fallback('unavailable');
      const probabilities = Object.fromEntries(Object.entries(parsed.data.answers).map(([key, value]) => [key, value.noul])) as NonNullable<BehaviorDecision['probabilities']>;
      const media: BehaviorDecision['media'] = {};
      for (const kind of ['image', 'video', 'voice'] as const) {
        if (probabilities[kind] >= config.mediaThreshold) media[kind] = true;
        else if (probabilities[kind] <= 1 - config.mediaThreshold) media[kind] = false;
      }
      return { status: 'ok', probabilities, media,
        memory: explicitMemoryIntent(userText) ?? (probabilities.memory >= config.memorySaveThreshold ? 'save' : probabilities.memory < config.memoryReviewThreshold ? 'skip' : 'review') };
    } catch {
      signal?.throwIfAborted();
      return fallback('unavailable');
    }
  }
}

export function decisionPrompt(decision: BehaviorDecision): string {
  if (decision.status !== 'ok') return '';
  const names = { image: '图片', video: '视频', voice: '语音' };
  const lines = Object.entries(decision.media).map(([kind, value]) => `${names[kind as keyof typeof names]}：${value ? '适合使用；能力与用户偏好允许时，按现有协议输出具体媒体意图标记' : '本轮不主动使用，不承诺发送这种媒体'}`);
  return `\n\n【本轮表达决策】\n${lines.join('\n')}\n用户明确要求或禁止的形式、能力是否可用、频率和额度限制优先。判断不确定的形式由你决定。文本照常回答，勿向用户提及内部决策分数。`;
}

/** High-confidence negative decisions gate autonomous markers, never explicit requests. */
export function applyBehaviorDecision(model: ModelDirectives, user: UserDirectives, decision?: BehaviorDecision): ModelDirectives {
  if (!decision || decision.status !== 'ok') return model;
  const next = { ...model };
  if (decision.media.image === false && !user.wantImage) { delete next.imagePrompt; delete next.selfImagePrompt; }
  if (decision.media.video === false && !user.wantVideo) { delete next.videoPrompt; delete next.selfVideoPrompt; }
  if (!user.wantVoice) {
    if (decision.media.voice === false) { delete next.voice; delete next.voiceOnly; }
    if (decision.media.voice === true && !user.noVoice) next.voice = true;
  }
  return next;
}
