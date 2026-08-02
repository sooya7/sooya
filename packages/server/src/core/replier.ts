import type { MessageRepo } from '../db/repos/message.repo.js';
import type { MediaStore } from '../media/store.js';
import type { StickerLibrary } from '../media/stickers.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { ContextBuilder } from './context.js';
import type { EventBus } from '../events/bus.js';
import type { ConfigStore } from '../config/store.js';
import type { ErrorLogRepo, SettingsRepo } from '../db/repos/misc.repo.js';
import type { ChatMessage, StreamEventType } from './types.js';
import {
  parseUserDirectives,
  stripModelDirectives,
  StreamingDirectiveFilter,
  type ModelDirectives,
  type UserDirectives
} from './directives.js';
import { stripSpeakerPrefix } from './speakerPrefix.js';
import {
  ImageEditUnsupportedError,
  ImageReferenceError,
  ProviderNotConfiguredError,
  type ChatTurn,
  type GeneratedImage
} from '../providers/types.js';
import { HttpTimeoutError } from '../util/http.js';
import { DEFAULT_VOICE_EMOTIONS, resolveVoiceDelivery, voiceMoodCatalogue, type VoiceEmotionMap } from './voice.js';
import { publicFailure, redactDiagnostic, type PublicFailure } from './public-error.js';

export interface ReplyOptions {
  recentMessages: number;
  memoryLimit: number;
}

export interface ReplyOutcome {
  messageId: string;
  ok: boolean;
  parts: string[];
  degraded: string[];
  error?: PublicFailure;
}

const NO_MODEL_FALLBACK =
  '（SOOYA 还没有配置聊天模型，所以现在只能给你这句占位回复。在 config/models.json 或环境变量里填好模型后我就能正常说话了。）';

/**
 * Turns a user message into SOOYA's multimedia reply.
 *
 * Guarantees:
 *  - the assistant message row is created before any media work, so a crash
 *    mid-generation still leaves a visible message;
 *  - each media part is only marked `sent` after the bytes are on disk;
 *  - a failing media part never removes the text part.
 */
export class Replier {
  private active = false;

  constructor(
    private readonly deps: {
      messages: MessageRepo;
      media: MediaStore;
      stickers: StickerLibrary;
      capabilities: CapabilityRegistry;
      context: ContextBuilder;
      bus: EventBus;
      config: ConfigStore;
      errorLog: ErrorLogRepo;
      settings: SettingsRepo;
    }
  ) {}

  get busy(): boolean {
    return this.active;
  }

  async reply(userMessage: ChatMessage, opts: ReplyOptions): Promise<ReplyOutcome> {
    return this.replyBatch([userMessage], opts);
  }

  async replyBatch(userMessages: ChatMessage[], opts: ReplyOptions, batchId?: string): Promise<ReplyOutcome> {
    if (userMessages.length === 0) throw new Error('cannot reply to an empty message batch');
    const latestUserMessage = userMessages[userMessages.length - 1]!;
    this.active = true;
    const persona = this.deps.config.getPersona();
    const degraded: string[] = [];
    const producedParts: string[] = [];

    const userText = userMessages
      .map((message) => message.content
        .map((p) => (p.type === 'text' ? p.text ?? '' : p.type === 'audio' ? p.transcript ?? '' : ''))
        .filter(Boolean)
        .join('\n'))
      .filter(Boolean)
      .join('\n');
    const userDirectives = userMessages.reduce(
      (merged, message) => mergeDirectives(merged, message.meta?.directives as UserDirectives),
      parseUserDirectives(userText)
    );

    // 1. Create the assistant shell message up front.
    let shell: ChatMessage;
    try {
      shell = this.stableBoundary(
        () => this.deps.messages.createInTransaction({
          role: 'assistant',
          status: 'sending',
          replyTo: latestUserMessage.id,
          parts: [],
          meta: { replyTo: latestUserMessage.id, batchId, batchMessageIds: userMessages.map((message) => message.id) }
        }).message,
        'reply.thinking',
        (message) => ({ messageId: message.id, replyTo: latestUserMessage.id })
      );
    } catch (error) {
      this.active = false;
      throw error;
    }

    try {
      const caps = this.deps.capabilities;
      const capabilityNotes: string[] = [];
      if (!caps.has('image')) capabilityNotes.push('图片生成不可用');
      if (!caps.has('tts')) capabilityNotes.push('语音合成不可用');
      if (this.deps.stickers.count() === 0) capabilityNotes.push('没有可用表情包');

      const allowVision = caps.visionProvider() !== null;
      const chatModel = this.deps.config.chatModelFor('chat');
      const visionModel = allowVision ? this.deps.config.chatModelFor('vision') : chatModel;
      const contextWindow = Math.min(chatModel.contextWindow, visionModel.contextWindow);
      const maxOutputTokens = Math.max(
        16,
        Math.min(Math.max(chatModel.maxTokens, visionModel.maxTokens), contextWindow - 384)
      );
      const built = await this.deps.context.build(persona, userText, {
        recentMessages: opts.recentMessages,
        memoryLimit: opts.memoryLimit,
        batchMessageIds: userMessages.map((message) => message.id),
        allowVision,
        stickerCatalogue: this.deps.stickers.catalogueForPrompt(),
        voiceMoods: voiceMoodCatalogue(
          this.deps.settings.get<VoiceEmotionMap>('voice.emotions', DEFAULT_VOICE_EMOTIONS)
        ),
        capabilityNotes,
        contextWindow,
        maxOutputTokens
      });
      const requestMaxTokens = Math.min(
        built.visionUsed ? visionModel.maxTokens : chatModel.maxTokens,
        maxOutputTokens
      );
      this.deps.messages.updateMeta(shell.id, {
        contextBudget: {
          inputBudget: built.inputBudget,
          estimatedInputTokens: built.estimatedInputTokens,
          maxOutputTokens,
          requestMaxTokens,
          droppedSummaries: built.droppedSummaries,
          droppedMemories: built.droppedMemories,
          droppedRecentMessages: built.droppedRecentMessages
        }
      });

      // 2. Stream the text.
      const provider = allowVision && built.visionUsed ? caps.visionProvider()! : caps.chatProvider();
      let rawText = '';
      let visibleText = '';
      const filter = new StreamingDirectiveFilter();
      let textPartId: string | null = null;

      const pushDelta = (delta: string) => {
        rawText += delta;
        const visible = filter.push(delta);
        if (!visible) return;
        visibleText += visible;
        if (!textPartId) {
          textPartId = this.deps.messages.appendPart(shell.id, { type: 'text', text: visibleText, status: 'pending' });
        } else {
          this.deps.messages.updatePart(textPartId, { text: visibleText });
        }
        this.deps.bus.publish('reply.text.delta', { messageId: shell.id, delta: visible });
      };

      if (provider.configured) {
        const streamTurns = (turns: ChatTurn[]) =>
          provider.stream(
            {
              system: built.system,
              messages: turns,
              maxTokens: requestMaxTokens,
              temperature: undefined
            },
            (chunk) => pushDelta(chunk.delta)
          );
        try {
          await streamTurns(built.turns);
        } catch (err) {
          let streamError: Error | null = err as Error;
          // Config can declare vision while the real endpoint has none: drop
          // the pictures and retry as plain text before failing the turn.
          if (built.visionUsed && isImageInputRejection(streamError)) {
            this.deps.errorLog.add('reply.chat', 'vision_input_rejected', { diagnostic: redactDiagnostic(streamError) });
            try {
              await streamTurns(textOnlyTurns(built.turns));
              degraded.push('chat:vision_unsupported');
              streamError = null;
            } catch (retryErr) {
              streamError = retryErr as Error;
            }
          }
          if (streamError) {
            const failure = publicFailure('provider_unavailable');
            this.deps.errorLog.add('reply.chat', failure.code, {
              incidentId: failure.incidentId,
              diagnostic: redactDiagnostic(streamError)
            });
            if (!visibleText) {
              const note =
                streamError instanceof HttpTimeoutError
                  ? '（模型响应超时了，稍后再试一次吧。）'
                  : `（${failure.message}）`;
              pushDelta(note);
              degraded.push('chat:provider_unavailable');
            } else {
              degraded.push('chat:provider_unavailable');
            }
          }
        }
      } else {
        pushDelta(NO_MODEL_FALLBACK);
        degraded.push('chat:not-configured');
      }

      const tail = filter.flush();
      if (tail) {
        visibleText += tail;
        if (textPartId) this.deps.messages.updatePart(textPartId, { text: visibleText });
        else if (visibleText.trim())
          textPartId = this.deps.messages.appendPart(shell.id, { type: 'text', text: visibleText, status: 'pending' });
      }

      const stripped = stripModelDirectives(rawText);
      const modelDirectives = stripped.directives;
      // Prefer the fully-stripped text (handles markers split across chunks).
      // 一对一私聊里不该出现「名字：」名牌，模型却常自带一个。
      const finalText = stripSpeakerPrefix(stripped.text || visibleText.trim(), [persona.name]);
      if (textPartId) {
        if (finalText) this.deps.messages.updatePart(textPartId, { text: finalText, status: 'sent' });
        else {
          this.deps.messages.deletePart(textPartId);
          textPartId = null;
        }
      } else if (finalText) {
        textPartId = this.deps.messages.appendPart(shell.id, { type: 'text', text: finalText, status: 'sent' });
      }
      if (textPartId) producedParts.push('text');
      this.deps.bus.publish('reply.text.done', { messageId: shell.id, text: finalText });

      // 3. Decide on media.
      const plan = this.planMedia(persona, userDirectives, modelDirectives, finalText);

      // 3a. Sticker
      if (plan.sticker) {
        this.deps.bus.publish('reply.sticker.selecting', { messageId: shell.id, hint: plan.stickerHint ?? null });
        // When the user asked to swap, exclude the last sticker unconditionally
        // — independent of the persona's avoidRepeatWindow setting.
        const window = plan.forceDifferent
          ? Math.max(persona.stickerPolicy.avoidRepeatWindow, 1)
          : persona.stickerPolicy.avoidRepeatWindow;
        const recent = this.recentStickerIds(window);
        let selection = this.deps.stickers.select({
          hint: plan.stickerHint,
          text: `${userText}\n${finalText}`,
          excludeIds: recent,
          requireMatch: plan.stickerRequired ? false : true
        });
        if (!selection && plan.stickerRequired && recent.length > 0) {
          // The hint matched nothing new: fall back to any other sticker rather
          // than repeating the one the user just rejected.
          selection = this.deps.stickers.select({
            hint: null,
            text: `${userText}\n${finalText}`,
            excludeIds: recent,
            requireMatch: false
          });
        }
        if (selection) {
          const partId = this.deps.messages.appendPart(shell.id, {
            type: 'sticker',
            mediaId: selection.sticker.mediaId,
            status: 'sent',
            meta: { stickerId: selection.sticker.id, stickerName: selection.sticker.name, reason: selection.reason }
          });
          this.deps.stickers.markUsed(selection.sticker.id);
          producedParts.push('sticker');
          this.deps.bus.publish('reply.media.saved', { messageId: shell.id, partId, kind: 'sticker' });
        } else {
          degraded.push('sticker:no-suitable-match');
        }
      }

      // 3b. Image
      if (plan.imagePrompt) {
        this.deps.bus.publish('reply.image.generating', { messageId: shell.id, prompt: plan.imagePrompt.slice(0, 200) });
        const referenceMediaIds = userMessages.flatMap((message) =>
          message.content.filter((part) => part.type === 'image' && part.mediaId).map((part) => part.mediaId!)
        );
        const partId = this.deps.messages.appendPart(shell.id, {
          type: 'image',
          status: 'pending',
          meta: {
            prompt: plan.imagePrompt.slice(0, 500),
            ...(referenceMediaIds.length === 1 ? { referenceMediaId: referenceMediaIds[0] } : {})
          }
        });
        try {
          if (referenceMediaIds.length > 1) {
            throw new ImageReferenceError(
              'too_many_reference_images',
              '一次图生图只能使用一张参考图',
              `received ${referenceMediaIds.length} reference images`
            );
          }
          const provider = this.deps.capabilities.imageProvider();
          let img: GeneratedImage;
          if (referenceMediaIds.length === 1) {
            const reference = await this.deps.media.read(referenceMediaIds[0]!);
            if (!reference) {
              throw new ImageReferenceError(
                'reference_generation_failed',
                '参考图不可用，请重新上传后再试',
                `reference media not found: ${referenceMediaIds[0]}`
              );
            }
            try {
              img = await provider.edit(plan.imagePrompt, reference.data, { mime: reference.row.mime });
            } catch (err) {
              if (!(err instanceof ImageEditUnsupportedError)) throw err;
              img = await provider.generate(plan.imagePrompt);
            }
          } else {
            img = await provider.generate(plan.imagePrompt);
          }
          const media = await this.deps.media.save({
            kind: 'image',
            origin: 'generated',
            data: img.data,
            declaredMime: img.mime,
            filename: 'generated.png',
            meta: { prompt: plan.imagePrompt.slice(0, 500) }
          });
          this.deps.messages.updatePart(partId, { mediaId: media.id, status: 'sent' });
          producedParts.push('image');
          this.deps.bus.publish('reply.media.saved', { messageId: shell.id, partId, kind: 'image', mediaId: media.id });
        } catch (err) {
          const e = err as Error;
          const failure = publicFailure('provider_unavailable');
          const reason = e instanceof ImageReferenceError
            ? e.publicMessage
            : e instanceof ProviderNotConfiguredError
              ? '图片生成服务没有配置。'
              : e instanceof HttpTimeoutError
                ? '图片生成超时，本次没有自动重试，以免重复生成。'
                : failure.message;
          this.deps.messages.updatePart(partId, {
            status: 'failed',
            error: reason,
            meta: { failure: { ...failure, message: reason } }
          });
          this.deps.errorLog.add('reply.image', failure.code, {
            incidentId: failure.incidentId,
            diagnostic: redactDiagnostic(e)
          });
          degraded.push(e instanceof ImageReferenceError ? `image:${e.code}` : 'image:provider_unavailable');
          // Never lose the text: add an explanatory note instead.
          if (!finalText) {
            this.deps.messages.appendPart(shell.id, {
              type: 'text',
              text: `（本来想给你画一张图，但${reason}。）`,
              status: 'sent'
            });
            producedParts.push('text');
          }
          this.deps.bus.publish('reply.media.saved', { messageId: shell.id, partId, kind: 'image', failed: true, reason });
        }
      }

      // 3c. Voice
      const voiceText = (finalText || '').trim();
      if (plan.voice && voiceText) {
        // Only the first maxCharsPerClip characters are synthesized (cost and
        // clip-length control), but the transcript always keeps the COMPLETE
        // text: in voice-only mode the transcript is the user's only copy of
        // the reply, so clipping it would destroy content permanently.
        const clipped = voiceText.slice(0, persona.voicePolicy.maxCharsPerClip);
        const wasClipped = clipped.length < voiceText.length;
        this.deps.bus.publish('reply.audio.generating', { messageId: shell.id, chars: clipped.length });
        const partId = this.deps.messages.appendPart(shell.id, {
          type: 'audio',
          status: 'pending',
          transcript: voiceText,
          meta: wasClipped ? { clipped: true, spokenChars: clipped.length, totalChars: voiceText.length } : {}
        });
        try {
          const emotions = this.deps.settings.get<VoiceEmotionMap>('voice.emotions', DEFAULT_VOICE_EMOTIONS);
          const delivery = resolveVoiceDelivery(clipped, modelDirectives.voiceEmotion ?? null, emotions);
          const audio = await this.deps.capabilities.ttsProvider().synthesize(clipped, delivery);
          const media = await this.deps.media.save({
            kind: 'audio',
            origin: 'generated',
            data: audio.data,
            declaredMime: audio.mime,
            filename: `voice.${audio.format}`,
            durationHint: audio.durationSec ?? null,
            transcript: voiceText,
            meta: { tts: true, ...(wasClipped ? { clipped: true, spokenChars: clipped.length } : {}) }
          });
          this.deps.messages.updatePart(partId, {
            mediaId: media.id,
            status: 'sent',
            duration: media.duration ?? audio.durationSec ?? null,
            transcript: voiceText
          });
          producedParts.push('audio');
          // voice-only: hide the text bubble but keep the transcript on the clip.
          // Only safe because the transcript above holds the full text; when the
          // clip covers just part of it the text bubble must stay visible.
          if (plan.voiceOnly && textPartId && !wasClipped) {
            this.deps.messages.deletePart(textPartId);
            textPartId = null;
            const i = producedParts.indexOf('text');
            if (i >= 0) producedParts.splice(i, 1);
          }
          this.deps.bus.publish('reply.media.saved', { messageId: shell.id, partId, kind: 'audio', mediaId: media.id });
        } catch (err) {
          const e = err as Error;
          const failure = publicFailure('provider_unavailable');
          const reason = e instanceof ProviderNotConfiguredError ? '语音合成服务没有配置。' : failure.message;
          this.deps.messages.updatePart(partId, { status: 'failed', error: reason, meta: { failure: { ...failure, message: reason } } });
          this.deps.errorLog.add('reply.tts', failure.code, {
            incidentId: failure.incidentId,
            diagnostic: redactDiagnostic(e)
          });
          degraded.push('audio:provider_unavailable');
          // TTS failure falls back to text — which is already present. When it
          // is not, restore the FULL text rather than the clip that would have
          // been spoken, otherwise a TTS outage silently truncates the reply.
          if (!textPartId) {
            textPartId = this.deps.messages.appendPart(shell.id, { type: 'text', text: voiceText, status: 'sent' });
            producedParts.push('text');
          }
          this.deps.bus.publish('reply.media.saved', { messageId: shell.id, partId, kind: 'audio', failed: true, reason });
        }
      }

      // sticker-only: drop the text part if the model asked for it and we do have a sticker.
      if (plan.stickerOnly && textPartId && producedParts.includes('sticker')) {
        this.deps.messages.deletePart(textPartId);
        textPartId = null;
        const i = producedParts.indexOf('text');
        if (i >= 0) producedParts.splice(i, 1);
      }

      // 4. Guarantee a non-empty message.
      this.stableBoundary(() => {
        const current = this.deps.messages.get(shell.id)!;
        const visibleParts = current.content.filter((p) => p.status !== 'failed');
        if (visibleParts.length === 0) {
          this.deps.messages.appendPart(shell.id, {
            type: 'text',
            text: '（这次没能生成内容，再说一次好吗？）',
            status: 'sent'
          });
          producedParts.push('text');
          degraded.push('empty-reply-guard');
        }

        this.deps.messages.setStatus(shell.id, 'sent', degraded.length ? degraded.join(',') : null);
        return this.deps.messages.get(shell.id)!;
      }, 'reply.completed', (message) => ({ message, degraded }), () => [
        { type: 'reply.content.done', payload: { messageId: shell.id, parts: producedParts } }
      ]);
      return { messageId: shell.id, ok: true, parts: producedParts, degraded };
    } catch (err) {
      const e = err as Error;
      const failure = publicFailure('reply_failed');
      this.deps.errorLog.add('reply', failure.code, {
        incidentId: failure.incidentId,
        diagnostic: redactDiagnostic(e)
      });
      this.stableBoundary(() => {
        this.deps.messages.setStatus(shell.id, 'failed', failure.message);
        this.deps.messages.updateMeta(shell.id, { failure });
        const failed = this.deps.messages.get(shell.id);
        if (failed && failed.content.length === 0) {
          this.deps.messages.appendPart(shell.id, {
            type: 'text',
            text: `（${failure.message} 事件编号：${failure.incidentId}）`,
            status: 'sent',
            meta: { failure }
          });
        }
        return this.deps.messages.get(shell.id)!;
      }, 'reply.failed', (message) => ({
        messageId: shell.id,
        code: failure.code,
        error: failure.message,
        incidentId: failure.incidentId,
        message
      }));
      return { messageId: shell.id, ok: false, parts: producedParts, degraded, error: failure };
    } finally {
      this.active = false;
    }
  }

  private stableBoundary<T>(
    mutation: () => T,
    type: StreamEventType,
    payload: (value: T) => Record<string, unknown>,
    preceding: (value: T) => Array<{ type: StreamEventType; payload: Record<string, unknown> }> = () => []
  ): T {
    let events: Array<ReturnType<EventBus['persist']>> = [];
    const value = this.deps.messages.inTransaction(() => {
      const result = mutation();
      events = [
        ...preceding(result).map((spec) => this.deps.bus.persist(spec.type, spec.payload)),
        this.deps.bus.persist(type, payload(result))
      ];
      return result;
    });
    for (const event of events) this.deps.bus.fanout(event);
    return value;
  }

  private recentStickerIds(window: number): string[] {
    if (window <= 0) return [];
    const recent = this.deps.messages.recent(Math.max(window * 2, 10));
    const ids: string[] = [];
    for (const m of recent.reverse()) {
      for (const p of m.content) {
        if (p.type === 'sticker' && p.meta?.stickerId) ids.push(String(p.meta.stickerId));
      }
      if (ids.length >= window) break;
    }
    return ids.slice(0, window);
  }

  private planMedia(
    persona: ReturnType<ConfigStore['getPersona']>,
    user: UserDirectives,
    model: ModelDirectives,
    text: string
  ): {
    sticker: boolean;
    stickerHint: string | null;
    stickerRequired: boolean;
    stickerOnly: boolean;
    forceDifferent: boolean;
    imagePrompt: string | null;
    voice: boolean;
    voiceOnly: boolean;
  } {
    const caps = this.deps.capabilities;
    const stickersAvailable = this.deps.stickers.count() > 0;

    // Sticker
    let sticker = false;
    let stickerHint: string | null = null;
    let stickerRequired = false;
    let forceDifferent = false;
    if (persona.stickerPolicy.enabled && stickersAvailable && !user.noSticker) {
      if (user.wantSticker) {
        sticker = true;
        stickerRequired = true;
        stickerHint = model.sticker && model.sticker !== 'auto' ? model.sticker : guessEmotion(text);
        // "换一个表情" must never return the same sticker again, even when the
        // persona disabled the repeat window or only one sticker matches the hint.
        forceDifferent = user.anotherSticker === true;
      } else if (model.sticker) {
        sticker = true;
        stickerHint = model.sticker === 'auto' ? guessEmotion(text) : model.sticker;
      }
    }
    const stickerOnly = sticker && (user.stickerOnly === true || model.stickerOnly === true);

    // Image
    let imagePrompt: string | null = null;
    if (persona.imagePolicy.enabled) {
      if (model.imagePrompt) imagePrompt = model.imagePrompt;
      else if (user.wantImage && user.imagePrompt) imagePrompt = user.imagePrompt;
    }
    if (imagePrompt && !caps.has('image') && !user.wantImage && !model.imagePrompt) imagePrompt = null;

    // Voice
    let voice = false;
    if (persona.voicePolicy.enabled && !user.noVoice) {
      voice = user.wantVoice === true || model.voice === true;
    }
    const voiceOnly = voice && (user.voiceOnly === true || model.voiceOnly === true);

    return { sticker, stickerHint, stickerRequired, stickerOnly, forceDifferent, imagePrompt, voice, voiceOnly };
  }
}

function mergeDirectives(parsed: UserDirectives, explicit?: UserDirectives): UserDirectives {
  if (!explicit) return parsed;
  return { ...parsed, ...Object.fromEntries(Object.entries(explicit).filter(([, v]) => v !== undefined)) };
}

/** A 4xx whose body complains about image/vision input, not a transient failure. */
const IMAGE_REJECTION = /image|vision|multimodal|图片/i;

function isImageInputRejection(err: Error): boolean {
  const status = (err as { status?: number }).status;
  if (typeof status !== 'number' || status < 400 || status >= 500) return false;
  return IMAGE_REJECTION.test(err.message);
}

/** Same conversation with image parts replaced by a plain-text marker. */
function textOnlyTurns(turns: ChatTurn[]): ChatTurn[] {
  return turns.map((turn) => {
    if (turn.content.every((p) => p.type === 'text')) return turn;
    const text = turn.content
      .map((p) => (p.type === 'text' ? p.text : '[图片]'))
      .filter((part) => part && part.trim())
      .join('\n');
    return { role: turn.role, content: [{ type: 'text', text: text || '[图片]' }] };
  });
}

const EMOTION_HINTS: Array<[RegExp, string]> = [
  [/哈哈|笑死|太好了|开心|棒|好耶|恭喜/, '开心'],
  [/晚安|睡了|困|休息/, '晚安'],
  [/难过|伤心|想哭|委屈|难受/, '难过'],
  [/生气|讨厌|烦|气死/, '生气'],
  [/别难过|抱抱|辛苦|加油|没事的/, '安慰'],
  [/害羞|不好意思|脸红/, '害羞'],
  [/为什么|怎么|吗\?|吗？|\?$|？$/, '疑惑'],
  [/无语|服了|尴尬/, '无语'],
  [/厉害|得意|嘿嘿|哼哼/, '得意'],
  [/求求|拜托|嘛~|好不好/, '撒娇']
];

export function guessEmotion(text: string): string {
  for (const [re, emotion] of EMOTION_HINTS) {
    if (re.test(text)) return emotion;
  }
  return '开心';
}
