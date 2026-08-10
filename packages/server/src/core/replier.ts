import type { MessageRepo } from '../db/repos/message.repo.js';
import type { MediaStore } from '../media/store.js';
import type { StickerLibrary } from '../media/stickers.js';
import type { PersonaReferenceLoader } from '../media/persona-references.js';
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
import { abortableDelay, StaleGenerationError } from '../util/abort.js';
import { DEFAULT_VOICE_EMOTIONS, resolveVoiceDelivery, voiceMoodCatalogue, type VoiceEmotionMap } from './voice.js';
import { parseVoiceIntent } from './voice/intent.js';
import { decideVoiceMode } from './voice/planner.js';
import type { VoiceService } from './voice/service.js';
import { MediaDirector } from './mediaDirector.js';
import { publicFailure, redactDiagnostic, type PublicFailure } from './public-error.js';
import { decideWebSearch } from './web-search/policy.js';
import { formatWebSearchContext } from './web-search/service.js';
import type { WebSearchResolver } from './web-search/registry.js';
import type { WebSearchResult } from './web-search/types.js';
import type { WorldSnapshot } from './world-context.js';

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

export interface GenerationOptions extends ReplyOptions {
  signal: AbortSignal;
  batchId: string;
  revision: number;
  owner: string;
  /** Model output is buffered in memory for this long before it may become visible. */
  publishGraceMs: number;
  /** Single model request timeout (providers may cap earlier). */
  requestTimeoutMs: number;
  /**
   * Opens the publish barrier for `batchId`/`revision`. Resolves true only for
   * the generation that wins the database race; a stale generation gets false
   * and must stop immediately.
   */
  beginPublish: () => Promise<boolean>;
}

export interface TextGenerationResult {
  /** Fully stripped, speaker-prefix-free visible text. */
  text: string;
  /** Raw model output before directive stripping. */
  rawText: string;
  directives: ModelDirectives;
  degraded: string[];
  contextBudget: Record<string, unknown>;
  firstTokenAt: number | null;
  /** True once the publish barrier opened (text may already be visible). */
  published: boolean;
  /** Set when the provider died AFTER something became visible. */
  interrupted?: Error;
  /**
   * C5: the user asked for a voice reply ("用语音回我"/"只发语音") and voice
   * is available, so phase 1 kept the whole reply hidden — no text was ever
   * streamed or persisted. Phase 2 publishes audio (or its text fallback)
   * only after TTS finishes.
   */
  hiddenDraft?: boolean;
  /** Bounded citation metadata only; raw provider payloads never enter this object. */
  webSearch?: WebSearchResult;
}

const NO_MODEL_FALLBACK =
  '（SOOYA 还没有配置聊天模型，所以现在只能给你这句占位回复。请在管理后台的“模型配置”中填好聊天模型。）';

/**
 * Two-phase multimedia replier.
 *
 * Phase 1 (`generateText`) streams the model into memory behind the publish
 * barrier: nothing is persisted or shown until `publishGraceMs` has passed,
 * which is what makes a newer user message able to silently replace a
 * generation that already started.
 *
 * Phase 2 (`publishGeneratedReply`) creates the assistant message (delayed —
 * no empty shells for interrupted generations), then attaches media. Media
 * failures never fail the text; the text once visible is never withdrawn.
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
      personaReferences: PersonaReferenceLoader;
      /** Independent voice system (Part 4); null when VOICE_V2_ENABLED=false. */
      voice?: VoiceService | null;
      voiceV2Enabled?: boolean;
      webSearch?: WebSearchResolver | null;
      worldSnapshot?: () => WorldSnapshot;
    }
  ) {}

  get busy(): boolean {
    return this.active;
  }

  /** Phase 1: stream the model behind the publish barrier. */
  async generateText(userMessages: ChatMessage[], options: GenerationOptions): Promise<TextGenerationResult> {
    if (userMessages.length === 0) throw new Error('cannot reply to an empty message batch');
    const { signal, batchId, revision } = options;
    const latestUserMessage = userMessages[userMessages.length - 1]!;
    this.active = true;
    try {
      const persona = this.deps.config.getPersona();
      const degraded: string[] = [];
      const userText = userMessages
        .map((message) =>
          message.content
            .filter((part) => part.type === 'text')
            .map((part) => (part.text ?? '').trim())
            .filter(Boolean)
            .join(' ')
        )
        .filter(Boolean)
        .join('\n');
      const userDirectives = userMessages.reduce(
        (merged, message) => mergeDirectives(merged, message.meta?.directives as UserDirectives),
        parseUserDirectives(userText)
      );

      const caps = this.deps.capabilities;
      const capabilityNotes: string[] = [];
      if (!caps.has('image')) capabilityNotes.push('图片生成不可用');
      if (!caps.has('tts')) capabilityNotes.push('语音合成不可用');
      if (this.deps.stickers.count() === 0) capabilityNotes.push('没有可用表情包');
      // C5: user-requested voice replies stay hidden until the voice (or its
      // text fallback) is ready. Only when voice V2 is actually available.
      const userVoiceIntent = parseVoiceIntent(userText);
      const hiddenDraft = this.deps.voiceV2Enabled !== false && this.deps.voice != null
        && caps.has('tts') && persona.voicePolicy.enabled
        && (userVoiceIntent === 'voice_only' || userVoiceIntent === 'voice_reply');

      const allowVision = caps.visionProvider() !== null;
      const chatModel = this.deps.config.chatModelFor('chat');
      const visionModel = allowVision ? this.deps.config.chatModelFor('vision') : chatModel;
      const contextWindow = Math.min(chatModel.contextWindow, visionModel.contextWindow);
      const maxOutputTokens = Math.max(
        16,
        Math.min(Math.max(chatModel.maxTokens, visionModel.maxTokens), contextWindow - 384)
      );
      const built = await this.deps.context.build(persona, userText, {
        recentMessages: options.recentMessages,
        memoryLimit: options.memoryLimit,
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
      const provider = allowVision && built.visionUsed ? caps.visionProvider()! : caps.chatProvider();
      const selectedModel = built.visionUsed ? visionModel : chatModel;
      const requestMaxTokens = Math.min(selectedModel.maxTokens, maxOutputTokens);
      let requestSystem = built.system;
      let webSearchResult: WebSearchResult | undefined;
      let nativeSearchAnswer: string | undefined;
      const searchDecision = decideWebSearch(userText);
      if (searchDecision.offer && this.deps.webSearch) {
        const city = this.deps.worldSnapshot?.().city ?? null;
        const localPrefix = searchDecision.reason === 'local' && city?.name
          ? [city.country ?? '中国', city.region, city.name].filter(Boolean).join('')
          : '';
        const query = localPrefix && !userText.includes(city!.name) ? `${localPrefix} ${userText}` : userText;
        const searchRequest = {
          query,
          maxResults: 5,
          ...(city?.name ? { city: city.name } : {}),
          ...(city?.region ? { region: city.region } : {}),
          ...(city?.country ? { country: city.country } : {}),
          ...(searchDecision.freshness ? { freshness: searchDecision.freshness } : {}),
          signal
        };
        const nativeSearch = provider.name === 'openai-responses' && selectedModel.supportsTools
          ? async (nativeSignal: AbortSignal): Promise<WebSearchResult | null> => {
              const native = await provider.complete({
                system: built.system,
                messages: built.turns,
                maxTokens: requestMaxTokens,
                temperature: undefined,
                signal: nativeSignal,
                webSearch: {
                  enabled: true,
                  userLocation: {
                    ...(webSearchCountryCode(city?.country) ? { countryCode: webSearchCountryCode(city?.country)! } : {}),
                    ...(city?.region ? { region: city.region } : {}),
                    ...(city?.name ? { city: city.name } : {})
                  }
                }
              });
              if (!native.webSearch?.used || !native.text.trim()) return null;
              return {
                provider: 'responses',
                query,
                answer: native.text,
                citations: native.webSearch.citations
              };
            }
          : undefined;
        const result = await this.deps.webSearch.resolve(searchRequest, nativeSearch);
        if (result) {
          webSearchResult = result;
          if (result.provider === 'responses') {
            nativeSearchAnswer = result.answer;
          } else {
            requestSystem = `${requestSystem}\n\n${formatWebSearchContext(result)}\n回答涉及上述材料的事实时使用 [1] 这样的编号标注来源；不要声称读取了未提供的网页正文。`;
          }
        } else {
          degraded.push('web-search:unavailable');
          requestSystem = `${requestSystem}\n\n联网搜索当前不可用。不要声称已经核实实时信息；请诚实说明无法可靠确认，并继续完成不依赖实时事实的部分。`;
        }
      }
      const contextBudget = {
        inputBudget: built.inputBudget,
        estimatedInputTokens: built.estimatedInputTokens,
        maxOutputTokens,
        requestMaxTokens,
        droppedSummaries: built.droppedSummaries,
        droppedMemories: built.droppedMemories,
        droppedRecentMessages: built.droppedRecentMessages
      };

      let rawText = '';
      let visibleText = '';
      const filter = new StreamingDirectiveFilter();
      let published = false;
      let textPartId: string | null = null;
      let shell: ChatMessage | null = null;
      let firstTokenAt: number | null = null;
      let interrupted: Error | undefined;
      const publishDeadline = Date.now() + options.publishGraceMs;

      const openBarrier = async (): Promise<ChatMessage | null> => {
        if (published) return shell;
        if (signal.aborted) throw signal.reason;
        const won = await options.beginPublish();
        if (!won) throw new StaleGenerationError('publish barrier lost');
        published = true;
        // The shell and its first events commit in ONE transaction: if the
        // events cannot be persisted, the shell rolls back with them, so a
        // crash/event failure can never leave a half-created bubble.
        const created = this.stableBoundary(
          () => this.createShell(userMessages, latestUserMessage, batchId),
          'reply.publishing.started',
          (message) => ({ batchId, revision, messageId: message.id }),
          (message) =>
            visibleText
              ? [{ type: 'reply.text.delta', payload: { messageId: message.id, delta: visibleText } }]
              : []
        );
        shell = created;
        if (visibleText) {
          textPartId = this.deps.messages.appendPart(created.id, {
            type: 'text',
            text: visibleText,
            status: 'pending',
            meta: webSearchPartMeta(webSearchResult)
          });
        }
        return created;
      };

      const persistDelta = (delta: string): void => {
        if (signal.aborted) return;
        if (!shell || !textPartId) return;
        visibleText += delta;
        this.deps.messages.updatePart(textPartId, { text: visibleText });
        this.deps.bus.publish('reply.text.delta', { messageId: shell.id, delta });
      };

      const pushDelta = (delta: string): void => {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        rawText += delta;
        const visible = filter.push(delta);
        if (!visible) return;
        if (!published) {
          visibleText += visible;
          if (!hiddenDraft && Date.now() >= publishDeadline) void openBarrier().catch(() => undefined);
          return;
        }
        persistDelta(visible);
      };

      const streamTurns = async (turns: ChatTurn[]): Promise<void> => {
        await provider.stream(
          {
            system: requestSystem,
            messages: turns,
            maxTokens: requestMaxTokens,
            temperature: undefined,
            signal
          },
          (chunk) => pushDelta(chunk.delta)
        );
      };

      let noModel = false;
      try {
        if (!caps.has('chat')) {
          noModel = true;
          pushDelta(NO_MODEL_FALLBACK);
          degraded.push('chat:not-configured');
        } else {
          try {
            if (nativeSearchAnswer) pushDelta(nativeSearchAnswer);
            else await streamTurns(built.turns);
          } catch (err) {
            let streamError: Error | null = err as Error;
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
              if (signal.aborted) throw signal.reason;
              const failure = publicFailure('provider_unavailable');
              this.deps.errorLog.add('reply.chat', failure.code, {
                incidentId: failure.incidentId,
                diagnostic: redactDiagnostic(streamError)
              });
              if (published) {
                interrupted = streamError;
                degraded.push('chat:provider_unavailable');
              } else {
                throw streamError;
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && (err.name === 'UserInterruptedError' || err.name === 'StaleGenerationError')) throw err;
        throw err;
      }

      const tail = filter.flush();
      if (tail) {
        rawText += tail;
        if (published) persistDelta(tail);
        else visibleText += tail;
      }

      // Model finished inside the grace window: hold the buffered text until
      // the deadline, then open the barrier once (still cancellable). A
      // hidden-draft replace never opens the barrier here — phase 2 publishes
      // the audio (or its text fallback) instead.
      if (!hiddenDraft && !published && (visibleText || noModel)) {
        const wait = Math.max(0, publishDeadline - Date.now());
        if (wait > 0) await abortableDelay(wait, signal);
        await openBarrier();
      }

      const stripped = stripModelDirectives(rawText);
      const modelDirectives = stripped.directives;
      const finalText = stripSpeakerPrefix(stripped.text || visibleText.trim(), [persona.name]);
      if (textPartId) {
        if (finalText) this.deps.messages.updatePart(textPartId, {
          text: finalText,
          status: 'sent',
          meta: webSearchPartMeta(webSearchResult)
        });
        else {
          this.deps.messages.deletePart(textPartId);
          textPartId = null;
        }
      } else if (finalText && !hiddenDraft) {
        // The barrier only opens when there is visible text to show; text that
        // materialised later (e.g. stripped directives resolving into content)
        // still needs a shell to attach to, created fenced behind the barrier.
        // A hidden-draft replace never publishes here — phase 2 owns the text.
        const currentShell = shell as ChatMessage | null;
        const created = published ? currentShell : await openBarrier();
        if (created) {
          textPartId = this.deps.messages.appendPart(created.id, {
            type: 'text',
            text: finalText,
            status: 'sent',
            meta: webSearchPartMeta(webSearchResult)
          });
        }
      }
      if (textPartId) {
        const currentShell = shell as ChatMessage | null;
        if (currentShell) this.deps.bus.publish('reply.text.done', { messageId: currentShell.id, text: finalText });
      }

      return {
        text: finalText,
        rawText,
        directives: modelDirectives,
        degraded,
        contextBudget,
        firstTokenAt,
        published,
        interrupted,
        hiddenDraft,
        webSearch: webSearchResult
      };
    } finally {
      this.active = false;
    }
  }

  /** Phase 2: persist the assistant message (if not yet created) and attach media. */
  async publishGeneratedReply(
    batch: { id: string; revision: number },
    userMessages: ChatMessage[],
    generated: TextGenerationResult,
    opts: { signal: AbortSignal; owner: string; beginPublish: () => Promise<boolean> }
  ): Promise<ReplyOutcome> {
    const { signal, beginPublish } = opts;
    const latestUserMessage = userMessages[userMessages.length - 1]!;
    const persona = this.deps.config.getPersona();
    const degraded = [...generated.degraded];
    const producedParts: string[] = [];
    const userText = userMessages
      .map((message) =>
        message.content
          .filter((part) => part.type === 'text')
          .map((part) => (part.text ?? '').trim())
          .filter(Boolean)
          .join(' ')
      )
      .filter(Boolean)
      .join('\n');
    const userDirectives = userMessages.reduce(
      (merged, message) => mergeDirectives(merged, message.meta?.directives as UserDirectives),
      parseUserDirectives(userText)
    );

    // C5: a hidden-draft replace published nothing in phase 1 — the shell is
    // created by the voice phase only once audio (or its text fallback) is
    // ready, so no empty bubble and no visible-then-vanished text.
    const userVoiceIntent = parseVoiceIntent(userText);
    const hiddenReplace = generated.hiddenDraft === true;
    let shell: ChatMessage | null = null;
    let textPartId: string | null = null;
    if (!hiddenReplace && !generated.published) {
      const won = await beginPublish();
      if (!won) throw new StaleGenerationError('publish barrier lost before media');
      shell = this.createShell(userMessages, latestUserMessage, batch.id);
      this.deps.bus.publish('reply.publishing.started', {
        batchId: batch.id,
        revision: batch.revision,
        messageId: shell.id
      });
      if (generated.text) {
        textPartId = this.deps.messages.appendPart(shell.id, {
          type: 'text',
          text: generated.text,
          status: 'sent',
          meta: webSearchPartMeta(generated.webSearch)
        });
        producedParts.push('text');
      }
    } else if (!hiddenReplace) {
      shell = this.deps.messages.findAssistantByBatchId(batch.id) ?? null;
      if (!shell) throw new Error(`assistant shell missing for batch ${batch.id}`);
      const textPart = shell.content.find((part) => part.type === 'text' && part.status === 'sent');
      if (textPart) {
        textPartId = textPart.id;
        producedParts.push('text');
      }
    }

    const finalText = generated.text;
    const plan = this.planMedia(persona, userDirectives, generated.directives, finalText);

    // 3a. Sticker (deferred for hidden-draft replace: the shell does not
    // exist until the voice is ready).
    if (plan.sticker && !shell) degraded.push('sticker:deferred');
    if (shell && plan.sticker) {
      this.deps.bus.publish('reply.sticker.selecting', { messageId: shell.id, hint: plan.stickerHint ?? null });
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

    // 3b. Image (deferred for hidden-draft replace, same reason).
    const imagePrompt = plan.selfImagePrompt ?? plan.imagePrompt;
    if (imagePrompt && !shell) degraded.push('image:deferred');
    if (shell && imagePrompt) {
      const referenceMediaIds = userMessages.flatMap((message) =>
        message.content.filter((part) => part.type === 'image' && part.mediaId).map((part) => part.mediaId!)
      );
      // Image Director: the main model's intent becomes a quality prompt
      // through the fixed template before it reaches Image2 (see
      // mediaDirector.ts). Editing a user-sent image skips the director — the
      // user's instruction is already precise and must not be rewritten.
      let finalImagePrompt = imagePrompt;
      const editingUserImage = referenceMediaIds.length === 1;
      if (!editingUserImage && this.deps.capabilities.has('chat')) {
        const director = new MediaDirector({
          config: this.deps.config,
          chatProvider: () => this.deps.capabilities.chatProvider()
        });
        const expanded = await director.image({
          scene: imagePrompt.slice(0, 400),
          intent: plan.selfImagePrompt ? 'selfie' : 'private snapshot'
        }, { signal });
        if (expanded.prompt && expanded.prompt.trim()) finalImagePrompt = expanded.prompt.trim();
      }
      this.deps.bus.publish('reply.image.generating', { messageId: shell.id, prompt: finalImagePrompt.slice(0, 200) });
      const partId = this.deps.messages.appendPart(shell.id, {
        type: 'image',
        status: 'pending',
        meta: {
          prompt: imagePrompt.slice(0, 500),
          selfie: !!plan.selfImagePrompt,
          ...(referenceMediaIds.length === 1 ? { referenceMediaId: referenceMediaIds[0] } : {})
        }
      });
      const imageStartedAt = Date.now();
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
            img = await provider.edit(finalImagePrompt, reference.data, { mime: reference.row.mime, signal });
          } catch (err) {
            if (!(err instanceof ImageEditUnsupportedError)) throw err;
            img = await provider.generate(finalImagePrompt, { signal });
          }
        } else if (plan.selfImagePrompt) {
          const refs = await this.deps.personaReferences.load(finalImagePrompt);
          img = refs.length > 0
            ? await provider.generate(finalImagePrompt, { referenceImages: refs, signal })
            : await provider.generate(finalImagePrompt, { signal });
        } else {
          img = await provider.generate(finalImagePrompt, { signal });
        }
        const media = await this.deps.media.save({
          kind: 'image',
          origin: 'generated',
          data: img.data,
          declaredMime: img.mime,
          filename: 'generated.png',
          meta: { prompt: imagePrompt.slice(0, 500), selfie: !!plan.selfImagePrompt }
        });
        this.deps.messages.updatePart(partId, {
          mediaId: media.id,
          status: 'sent',
          duration: Math.round((Date.now() - imageStartedAt) / 1000)
        });
        producedParts.push('image');
        this.deps.bus.publish('reply.media.saved', { messageId: shell.id, partId, kind: 'image', mediaId: media.id });
      } catch (err) {
        if (signal.aborted) throw signal.reason;
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
          duration: Math.round((Date.now() - imageStartedAt) / 1000),
          meta: { failure: { ...failure, message: reason } }
        });
        this.deps.errorLog.add('reply.image', failure.code, {
          incidentId: failure.incidentId,
          diagnostic: redactDiagnostic(e)
        });
        degraded.push(e instanceof ImageReferenceError ? `image:${e.code}` : 'image:provider_unavailable');
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

    // 3c. Voice — independent expression system (Part 4): intent → mode →
    // spoken script → naturalness guard → delivery → TTS → publication.
    if (this.deps.voice && this.deps.voiceV2Enabled !== false) {
      const userIntent = parseVoiceIntent(userText);
      // P0-3: replace/voice-only is reserved for EXPLICIT user intent. A model
      // that emits [[voice-only]] on its own is downgraded to complement — the
      // user never asked for the text to be replaced, and a visible text that
      // suddenly vanishes is a broken experience.
      const userWantsReplace = userIntent === 'voice_only' || userIntent === 'voice_reply';
      const modelMarker = generated.directives.voiceOnly
        ? (userWantsReplace ? 'replace' : 'complement')
        : generated.directives.voice
          ? 'complement'
          : null;
      const decision = decideVoiceMode({
        userIntent,
        modelVoice: modelMarker,
        text: finalText || '',
        persona: { name: persona.name, voicePolicy: persona.voicePolicy },
        preferences: this.deps.voice.preferences,
        ttsConfigured: this.deps.capabilities.has('tts'),
        recentAutoCount: this.deps.voice.autoCountToday(),
        dailyAutoCap: this.deps.voice.dailyAutoCap,
        inSilentHours: false,
        style: this.deps.voice.speechStyle
      });
      if (decision.mode) {
        this.deps.bus.publish('voice.plan.created', {
          batchId: batch.id, revision: batch.revision, mode: decision.mode, requestedBy: decision.requestedBy, reason: decision.reason
        });
        const voiceDraft = hiddenReplace && decision.mode === 'replace';
        const voiceResult = await this.deps.voice.synthesizeInlineVoice({
          batchId: batch.id,
          revision: batch.revision,
          shell: voiceDraft ? null : shell,
          textPartId: voiceDraft ? null : textPartId,
          finalText: finalText || '',
          userText,
          decision,
          modelEmotion: generated.directives.voiceEmotion ?? null,
          signal,
          persona,
          ...(voiceDraft
            ? {
                // C5: open the publish barrier and create the shell only now
                // that the audio is ready — fenced on the batch revision.
                openShell: async () => {
                  const won = await beginPublish();
                  if (!won) throw new StaleGenerationError('publish barrier lost before voice');
                  const created = this.createShell(userMessages, latestUserMessage, batch.id);
                  this.deps.bus.publish('reply.publishing.started', {
                    batchId: batch.id,
                    revision: batch.revision,
                    messageId: created.id
                  });
                  return created;
                }
              }
            : {})
        });
        degraded.push(...voiceResult.degraded);
        if (voiceResult.shellId) shell = this.deps.messages.get(voiceResult.shellId) ?? null;
        if (voiceResult.partId && !producedParts.includes('audio')) producedParts.push('audio');
        if (decision.mode === 'replace' && voiceResult.ok && voiceResult.mediaId) {
          const textIdx = producedParts.indexOf('text');
          if (textIdx >= 0) producedParts.splice(textIdx, 1);
        }
      } else if (hiddenReplace) {
        // Voice was requested but is unavailable (disabled / not configured):
        // publish the buffered text as a normal reply.
        const won = await beginPublish();
        if (!won) throw new StaleGenerationError('publish barrier lost before text fallback');
        shell = this.createShell(userMessages, latestUserMessage, batch.id);
        this.deps.bus.publish('reply.publishing.started', {
          batchId: batch.id,
          revision: batch.revision,
          messageId: shell.id
        });
        if (generated.text) {
          textPartId = this.deps.messages.appendPart(shell.id, {
            type: 'text',
            text: generated.text,
            status: 'sent',
            meta: webSearchPartMeta(generated.webSearch)
          });
          producedParts.push('text');
        }
      }
    } else {
      // Legacy read-back path (VOICE_V2_ENABLED=false).
      if (!shell) throw new StaleGenerationError('reply shell missing before legacy voice');
      const voiceText = (finalText || '').trim();
      if (plan.voice && voiceText) {
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
        const delivery = resolveVoiceDelivery(clipped, generated.directives.voiceEmotion ?? null, emotions);
        const audio = await this.deps.capabilities.ttsProvider().synthesize(clipped, {
          ...delivery,
          signal
        });
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
          duration: audio.durationSec ? Math.round(audio.durationSec) : null
        });
        producedParts.push('audio');
        this.deps.bus.publish('reply.media.saved', { messageId: shell.id, partId, kind: 'audio', mediaId: media.id });
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        const e = err as Error;
        const failure = publicFailure('provider_unavailable');
        const reason = e instanceof ProviderNotConfiguredError
          ? '语音合成服务没有配置。'
          : e instanceof HttpTimeoutError
            ? '语音生成超时。'
            : failure.message;
        this.deps.messages.updatePart(partId, { status: 'failed', error: reason, meta: { failure: { ...failure, message: reason } } });
        this.deps.errorLog.add('reply.tts', failure.code, {
          incidentId: failure.incidentId,
          diagnostic: redactDiagnostic(e)
        });
        degraded.push('audio:provider_unavailable');
        if (!textPartId) {
          textPartId = this.deps.messages.appendPart(shell.id, { type: 'text', text: voiceText, status: 'sent' });
          producedParts.push('text');
        }
        this.deps.bus.publish('reply.media.saved', { messageId: shell.id, partId, kind: 'audio', failed: true, reason });
      }
      }
    }
    // Every path above (hidden-draft voice, text fallback, legacy voice) ends
    // with a shell; a missing one means the publish barrier was lost.
    if (!shell) throw new StaleGenerationError('reply shell missing after voice publication');

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
      const note = [...degraded, ...(generated.interrupted ? ['partial'] : [])].join(',');
      this.deps.messages.setStatus(shell.id, 'sent', note || null);
      return this.deps.messages.get(shell.id)!;
    }, 'reply.content.done', (message) => ({ message, degraded }), () => [
      { type: 'reply.content.done', payload: { messageId: shell.id, parts: producedParts } }
    ]);
    return { messageId: shell.id, ok: true, parts: producedParts, degraded };
  }

  /** Legacy one-shot reply used when REPLY_INTERRUPTIBLE_GENERATION=false. */
  async replyBatch(userMessages: ChatMessage[], opts: ReplyOptions, batchId?: string): Promise<ReplyOutcome> {
    if (userMessages.length === 0) throw new Error('cannot reply to an empty message batch');
    const controller = new AbortController();
    const generated = await this.generateText(userMessages, {
      ...opts,
      signal: controller.signal,
      batchId: batchId ?? 'legacy',
      revision: 1,
      owner: 'legacy',
      publishGraceMs: 0,
      requestTimeoutMs: 45_000,
      beginPublish: async () => true
    });
    return this.publishGeneratedReply(
      { id: batchId ?? 'legacy', revision: 1 },
      userMessages,
      generated,
      { signal: controller.signal, owner: 'legacy', beginPublish: async () => true }
    );
  }

  private createShell(
    userMessages: ChatMessage[],
    latestUserMessage: ChatMessage,
    batchId: string
  ): ChatMessage {
    // Quote rules: only a single plain message keeps the implicit replyTo;
    // auto-merged batches show no quote card; an explicit user-selected target
    // is preserved and flagged for the frontend.
    const explicitReplyTo = latestUserMessage.replyTo ?? null;
    const autoBatch = userMessages.length > 1;
    return this.deps.messages.createInTransaction({
      role: 'assistant',
      status: 'sending',
      replyTo: explicitReplyTo ?? latestUserMessage.id,
      batchId,
      parts: [],
      meta: {
        replyMode: explicitReplyTo ? 'explicit' : autoBatch ? 'auto-batch' : 'direct',
        ...(explicitReplyTo ? { explicitReplyTo } : {}),
        batchId,
        batchMessageIds: userMessages.map((message) => message.id)
      }
    }).message;
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
    selfImagePrompt: string | null;
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
      sticker = user.wantSticker === true || user.stickerOnly === true || model.sticker !== undefined;
      // A user asking for a sticker must get one: requireMatch is disabled so
      // the library can fall back to any sticker when the hint matches nothing
      // (e.g. the previous one is excluded by the repeat window).
      stickerRequired = user.wantSticker === true || user.stickerOnly === true || model.stickerOnly === true;
      forceDifferent = user.anotherSticker === true;
      if (sticker) {
        const hint = model.sticker;
        if (typeof hint === 'string' && hint !== 'auto') stickerHint = hint;
        else stickerHint = guessEmotion(text);
      }
    }
    const stickerOnly = sticker && (user.stickerOnly === true || model.stickerOnly === true);

    // Image
    let imagePrompt: string | null = null;
    let selfImagePrompt: string | null = null;
    if (persona.imagePolicy.enabled && persona.referenceImages.length > 0) {
      if (model.selfImagePrompt) selfImagePrompt = model.selfImagePrompt;
    }
    if (persona.imagePolicy.enabled) {
      if (model.imagePrompt) imagePrompt = model.imagePrompt;
      else if (user.wantImage && user.imagePrompt) {
        if (user.selfieIntent && persona.referenceImages.length > 0) selfImagePrompt = user.imagePrompt;
        else imagePrompt = user.imagePrompt;
      }
    }
    if (selfImagePrompt && !caps.has('image')) selfImagePrompt = null;
    if (imagePrompt && !caps.has('image') && !user.wantImage && !model.imagePrompt) imagePrompt = null;

    // Voice
    let voice = false;
    if (persona.voicePolicy.enabled && !user.noVoice) {
      voice = user.wantVoice === true || model.voice === true;
    }
    const voiceOnly = voice && (user.voiceOnly === true || model.voiceOnly === true);

    return { sticker, stickerHint, stickerRequired, stickerOnly, forceDifferent, imagePrompt, selfImagePrompt, voice, voiceOnly };
  }
}

function webSearchPartMeta(result?: WebSearchResult): Record<string, unknown> | undefined {
  if (!result) return undefined;
  const seen = new Set<string>();
  const citations = result.citations.flatMap((citation) => {
    try {
      const url = new URL(citation.url);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || seen.has(url.toString())) return [];
      seen.add(url.toString());
      return [{ title: citation.title.trim() || url.hostname, url: url.toString() }];
    } catch {
      return [];
    }
  }).slice(0, 5);
  return {
    webSearchUsed: true,
    webSearchProvider: result.provider,
    webCitations: citations
  };
}

function webSearchCountryCode(country?: string | null): string | undefined {
  const normalized = country?.trim();
  if (!normalized) return undefined;
  if (/^[a-z]{2}$/i.test(normalized)) return normalized.toUpperCase();
  if (/^(中国|中华人民共和国|china)$/i.test(normalized)) return 'CN';
  return undefined;
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
