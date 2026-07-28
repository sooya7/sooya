import type { MessageRepo } from '../db/repos/message.repo.js';
import type { MediaStore } from '../media/store.js';
import type { StickerLibrary } from '../media/stickers.js';
import type { CapabilityRegistry } from './capabilities.js';
import type { ContextBuilder } from './context.js';
import type { EventBus } from '../events/bus.js';
import type { ConfigStore } from '../config/store.js';
import type { ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { ChatMessage } from './types.js';
import {
  parseUserDirectives,
  stripModelDirectives,
  StreamingDirectiveFilter,
  type ModelDirectives,
  type UserDirectives
} from './directives.js';
import { ProviderNotConfiguredError } from '../providers/types.js';
import { HttpTimeoutError } from '../util/http.js';

export interface ReplyOptions {
  recentMessages: number;
  memoryLimit: number;
}

export interface ReplyOutcome {
  messageId: string;
  ok: boolean;
  parts: string[];
  degraded: string[];
  error?: string;
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
    }
  ) {}

  get busy(): boolean {
    return this.active;
  }

  async reply(userMessage: ChatMessage, opts: ReplyOptions): Promise<ReplyOutcome> {
    this.active = true;
    const persona = this.deps.config.getPersona();
    const degraded: string[] = [];
    const producedParts: string[] = [];

    const userText = userMessage.content
      .map((p) => (p.type === 'text' ? p.text ?? '' : p.type === 'audio' ? p.transcript ?? '' : ''))
      .filter(Boolean)
      .join('\n');
    const userDirectives = mergeDirectives(parseUserDirectives(userText), userMessage.meta?.directives as UserDirectives);

    // 1. Create the assistant shell message up front.
    const { message: shell } = this.deps.messages.create({
      role: 'assistant',
      status: 'sending',
      replyTo: userMessage.id,
      parts: [],
      meta: { replyTo: userMessage.id }
    });
    this.deps.bus.publish('reply.thinking', { messageId: shell.id, replyTo: userMessage.id });

    try {
      const caps = this.deps.capabilities;
      const capabilityNotes: string[] = [];
      if (!caps.has('image')) capabilityNotes.push('图片生成不可用');
      if (!caps.has('tts')) capabilityNotes.push('语音合成不可用');
      if (this.deps.stickers.count() === 0) capabilityNotes.push('没有可用表情包');

      const allowVision = caps.visionProvider() !== null;
      const built = await this.deps.context.build(persona, userText, {
        recentMessages: opts.recentMessages,
        memoryLimit: opts.memoryLimit,
        allowVision,
        stickerCatalogue: this.deps.stickers.catalogueForPrompt(),
        capabilityNotes
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
        this.deps.bus.publish('reply.text.delta', { messageId: shell.id, delta: visible, text: visibleText });
      };

      if (provider.configured) {
        try {
          await provider.stream(
            {
              system: built.system,
              messages: built.turns,
              maxTokens: undefined,
              temperature: undefined
            },
            (chunk) => pushDelta(chunk.delta)
          );
        } catch (err) {
          const e = err as Error;
          this.deps.errorLog.add('reply.chat', e.message);
          if (!visibleText) {
            const note =
              e instanceof HttpTimeoutError
                ? '（模型响应超时了，稍后再试一次吧。）'
                : `（模型请求失败：${shortError(e)}）`;
            pushDelta(note);
            degraded.push(`chat:${e.name}`);
          } else {
            degraded.push(`chat-partial:${e.name}`);
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
      const finalText = stripped.text || visibleText.trim();
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
        const partId = this.deps.messages.appendPart(shell.id, {
          type: 'image',
          status: 'pending',
          meta: { prompt: plan.imagePrompt.slice(0, 500) }
        });
        try {
          const img = await this.deps.capabilities.imageProvider().generate(plan.imagePrompt);
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
          const reason = e instanceof ProviderNotConfiguredError ? '图片生成没有配置' : shortError(e);
          this.deps.messages.updatePart(partId, { status: 'failed', error: reason });
          this.deps.errorLog.add('reply.image', e.message);
          degraded.push(`image:${e.name}`);
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
          const audio = await this.deps.capabilities.ttsProvider().synthesize(clipped);
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
          const reason = e instanceof ProviderNotConfiguredError ? '语音合成没有配置' : shortError(e);
          this.deps.messages.updatePart(partId, { status: 'failed', error: reason });
          this.deps.errorLog.add('reply.tts', e.message);
          degraded.push(`tts:${e.name}`);
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
      let finalMessage = this.deps.messages.get(shell.id)!;
      const visibleParts = finalMessage.content.filter((p) => p.status !== 'failed');
      if (visibleParts.length === 0) {
        this.deps.messages.appendPart(shell.id, {
          type: 'text',
          text: '（这次没能生成内容，再说一次好吗？）',
          status: 'sent'
        });
        producedParts.push('text');
        degraded.push('empty-reply-guard');
        finalMessage = this.deps.messages.get(shell.id)!;
      }

      this.deps.messages.setStatus(shell.id, 'sent', degraded.length ? degraded.join(',') : null);
      finalMessage = this.deps.messages.get(shell.id)!;
      this.deps.bus.publish('reply.content.done', { messageId: shell.id, parts: producedParts });
      this.deps.bus.publish('reply.completed', { message: finalMessage, degraded });
      return { messageId: shell.id, ok: true, parts: producedParts, degraded };
    } catch (err) {
      const e = err as Error;
      this.deps.errorLog.add('reply', e.message, { stack: e.stack?.slice(0, 1000) });
      this.deps.messages.setStatus(shell.id, 'failed', shortError(e));
      const failed = this.deps.messages.get(shell.id);
      if (failed && failed.content.length === 0) {
        this.deps.messages.appendPart(shell.id, { type: 'text', text: `（回复失败：${shortError(e)}）`, status: 'sent' });
      }
      this.deps.bus.publish('reply.failed', {
        messageId: shell.id,
        error: shortError(e),
        message: this.deps.messages.get(shell.id)
      });
      return { messageId: shell.id, ok: false, parts: producedParts, degraded, error: shortError(e) };
    } finally {
      this.active = false;
    }
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

function shortError(err: Error): string {
  return `${err.name}: ${err.message}`.slice(0, 200);
}
