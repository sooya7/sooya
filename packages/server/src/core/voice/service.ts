import type { MessageRepo } from '../../db/repos/message.repo.js';
import type { VoiceGenerationRepo } from '../../db/repos/voice.repo.js';
import type { ReplyBatchRepo } from '../../db/repos/reply-batch.repo.js';
import type { MediaStore } from '../../media/store.js';
import type { CapabilityRegistry } from '../capabilities.js';
import type { ConfigStore } from '../../config/store.js';
import type { EventBus } from '../../events/bus.js';
import type { ErrorLogRepo, SettingsRepo } from '../../db/repos/misc.repo.js';
import type { ChatMessage, StreamEventType } from '../types.js';
import { HttpTimeoutError } from '../../util/http.js';
import { abortableDelay, StaleGenerationError } from '../../util/abort.js';
import { redactDiagnostic } from '../public-error.js';
import { DEFAULT_VOICE_EMOTIONS, resolveVoiceDelivery, type VoiceEmotionMap } from '../voice.js';
import { planDelivery, deliveryToTTSOptions } from './delivery.js';
import { parseVoiceIntent, mergeVoiceDirectives } from './intent.js';
import { assessNaturalness, estimateSpeechSeconds, voiceTextSimilarity, splitSentences } from './naturalness.js';
import { normalizeVoiceText, ruleBasedColloquial } from './normalize.js';
import { decideVoiceMode } from './planner.js';
import type { VoiceDecision } from './planner.js';
import { DEFAULT_SPEECH_STYLE, stylePromptHints } from './style.js';
import type { PersonaSpeechStyle } from './style.js';
import type { UserVoicePreferences, VoiceMode, VoiceRequestedBy, VoiceScript, VoicePartMeta, VoiceDeliveryPlan } from './types.js';
import { DEFAULT_VOICE_PREFERENCES } from './types.js';

export type { VoiceIntent } from './types.js';
export { parseVoiceIntent, mergeVoiceDirectives } from './intent.js';
export { decideVoiceMode } from './planner.js';
export type { VoiceDecision } from './planner.js';
export { assessNaturalness, voiceTextSimilarity, estimateSpeechSeconds, splitSentences } from './naturalness.js';
export { normalizeVoiceText, ruleBasedColloquial } from './normalize.js';
export { planDelivery } from './delivery.js';
export type { VoiceDeliveryPlan, UserVoicePreferences, VoiceMode, VoiceScript, VoicePartMeta } from './types.js';
export { DEFAULT_VOICE_PREFERENCES } from './types.js';
export { DEFAULT_SPEECH_STYLE, stylePromptHints } from './style.js';
export type { PersonaSpeechStyle } from './style.js';

const MODE_PROMPT: Record<VoiceMode, string> = {
  replace: '语音承担完整回答，文字将不显示；要让对方只听语音就能完全明白。',
  complement: '文字已经提供了主要信息，语音只补充更适合用声音表达的关心、态度或温度；不要复述文字内容。',
  summary: '文字较长，语音用自然口语概括重点；保留主结论，不逐条念列表，不要省略关键提醒。',
  read_aloud: '按原文朗读，不改语义。'
};

/** Feature switches resolved from env at wiring time (D4). */
export interface VoiceFlags {
  independentScript: boolean;
  naturalnessGuard: boolean;
  advancedDelivery: boolean;
  autoComplement: boolean;
  readAloud: boolean;
  ttsRetries: number;
}

export const DEFAULT_VOICE_FLAGS: VoiceFlags = {
  independentScript: true,
  naturalnessGuard: true,
  advancedDelivery: true,
  autoComplement: true,
  readAloud: true,
  ttsRetries: 0
};

export interface InlineVoiceArgs {
  batchId: string;
  revision: number;
  /** The assistant message once it exists; null for hidden-draft replace (C5). */
  shell: ChatMessage | null;
  textPartId: string | null;
  finalText: string;
  userText: string;
  decision: VoiceDecision;
  modelEmotion: string | null;
  signal: AbortSignal;
  persona: ReturnType<ConfigStore['getPersona']>;
  /**
   * C5: for hidden-draft replace the shell is created only after TTS (or the
   * text fallback) is ready, so no empty bubble and no visible text ever
   * existed. The callback opens the publish barrier and creates the shell.
   */
  openShell?: () => ChatMessage | Promise<ChatMessage>;
}

export interface InlineVoiceResult {
  ok: boolean;
  degraded: string[];
  partId: string | null;
  mediaId: string | null;
  generationId: string | null;
  /** The message the audio/text was attached to (set for hidden-draft replace). */
  shellId: string | null;
}

/**
 * Voice expression service (Part 4): intent → mode → spoken script →
 * naturalness guard → delivery plan → TTS → publication, with per-mode
 * fallbacks and full revision/abort discipline.
 */
export class VoiceService {
  private readonly active = new Map<string, AbortController>();

  /** Daily cap for AUTO voice messages (set from env at wiring time). */
  dailyAutoCap = 20;

  constructor(
    private readonly deps: {
      messages: MessageRepo;
      media: MediaStore;
      voice: VoiceGenerationRepo;
      batches: ReplyBatchRepo;
      capabilities: CapabilityRegistry;
      config: ConfigStore;
      settings: SettingsRepo;
      bus: EventBus;
      errorLog: ErrorLogRepo;
      flags?: Partial<VoiceFlags>;
    }
  ) {}

  get flags(): VoiceFlags {
    return { ...DEFAULT_VOICE_FLAGS, ...(this.deps.flags ?? {}) };
  }

  get preferences(): UserVoicePreferences {
    return this.deps.settings.get<UserVoicePreferences>('voice.preferences', DEFAULT_VOICE_PREFERENCES);
  }

  get speechStyle(): PersonaSpeechStyle {
    return this.deps.settings.get<PersonaSpeechStyle>('voice.speechStyle', DEFAULT_SPEECH_STYLE);
  }

  /** How many auto voices today (for the daily cap). */
  autoCountToday(): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return this.deps.voice.countAutoSince(start.toISOString());
  }

  /**
   * C4: the publish barrier may have moved on while TTS was running. Retry
   * paths carry synthetic batch ids and are not fenceable.
   */
  private isStale(args: { batchId: string; revision: number }): boolean {
    if (!args.batchId || args.batchId === 'retry' || args.batchId === 'legacy') return false;
    return !this.deps.batches.isCurrentRevision(args.batchId, args.revision);
  }

  private markSuperseded(generationId: string, args: { batchId: string; revision: number; messageId?: string | null }, mode: VoiceMode): void {
    this.deps.voice.update(generationId, { status: 'superseded', failed_at: new Date().toISOString(), failure_code: 'superseded' });
    this.emit('voice.generation.superseded', {
      voiceGenerationId: generationId,
      batchId: args.batchId,
      revision: args.revision,
      messageId: args.messageId,
      mode,
      status: 'superseded'
    });
  }

  /**
   * Full inline voice flow, called from the replier's phase 2 (media attach).
   * Returns degraded notes; never throws for provider failures (falls back
   * per mode) — only aborts/stale revisions propagate.
   */
  async synthesizeInlineVoice(args: InlineVoiceArgs): Promise<InlineVoiceResult> {
    const { decision, signal, persona } = args;
    const mode = decision.mode;
    if (!mode) return { ok: false, degraded: ['voice:no-mode'], partId: null, mediaId: null, generationId: null, shellId: null };
    const degraded: string[] = [];
    const maxSeconds = this.speechStyle.maxVoiceSeconds || persona.voicePolicy.maxCharsPerClip / 8;
    const maxChars = persona.voicePolicy.maxCharsPerClip;

    // 1. Script.
    let script: VoiceScript | null = null;
    if (mode === 'read_aloud') {
      script = {
        spokenText: args.finalText,
        mode: 'read_aloud',
        purpose: 'read_aloud',
        estimatedSeconds: estimateSpeechSeconds(args.finalText),
        semanticClaims: [],
        styleTags: ['read-aloud']
      };
    } else {
      if (this.flags.independentScript) {
        script = await this.generateScript(args.finalText, mode, args.userText, maxSeconds, signal, 0);
      }
      if (script && this.flags.naturalnessGuard && !this.guardAccepts(script, args.finalText, mode, maxSeconds)) {
        const report = assessNaturalness(script.spokenText, args.finalText, mode, { maxVoiceSeconds: maxSeconds });
        // One rewrite with the report.
        script = await this.generateScript(args.finalText, mode, args.userText, maxSeconds, signal, 1, report.reasons);
        if (script && this.flags.naturalnessGuard && !this.guardAccepts(script, args.finalText, mode, maxSeconds)) {
          script = this.degradeScript(script, args.finalText, mode, maxChars);
          if (!script && mode !== 'replace') {
            return { ok: false, degraded: [...degraded, 'voice:skipped-naturalness'], partId: null, mediaId: null, generationId: null, shellId: null };
          }
        }
      }
      if (!script) {
        if (mode === 'replace') {
          const fallback = ruleBasedColloquial(args.finalText, maxChars);
          script = { spokenText: fallback, mode: 'replace', purpose: 'full_answer', estimatedSeconds: estimateSpeechSeconds(fallback), semanticClaims: [], styleTags: ['rule-fallback'] };
          degraded.push('voice:script-fallback-rules');
        } else {
          return { ok: false, degraded: [...degraded, 'voice:no-script'], partId: null, mediaId: null, generationId: null, shellId: null };
        }
      }
    }

    // 2. Normalize: transcript stays human, synthesis gets cleaned (D1).
    const { spokenText, synthesisText } = normalizeVoiceText(script.spokenText);
    if (!spokenText.trim()) return { ok: false, degraded: [...degraded, 'voice:empty-script'], partId: null, mediaId: null, generationId: null, shellId: null };
    // Only the first maxChars characters are synthesized (cost and clip-length
    // control); the transcript always keeps the COMPLETE script so nothing the
    // user could have heard is ever lost from the stored copy.
    const clippedSynthesis = synthesisText.length > maxChars ? synthesisText.slice(0, maxChars) : synthesisText;
    const wasClipped = clippedSynthesis.length < synthesisText.length;

    // 3. Delivery. Explicit emotion wins; otherwise detect it from the reply
    // text through the saved mapping, like the legacy read-back path did.
    const emotions = this.deps.settings.get<VoiceEmotionMap>('voice.emotions', DEFAULT_VOICE_EMOTIONS);
    const emotion = decision.emotion ?? args.modelEmotion ?? resolveVoiceDelivery(args.finalText, null, emotions).emotion;
    const delivery = planDelivery(emotion);
    const ttsOptions = deliveryToTTSOptions(delivery, emotions, {
      advanced: this.flags.advancedDelivery,
      customPresets: this.deps.settings.has('voice.emotions')
    });

    // 4. Generation record. For a hidden-draft replace the shell does not
    // exist yet; message_id/text_part_id are filled in once published.
    const generation = this.deps.voice.create({
      batchId: args.batchId,
      revision: args.revision,
      messageId: args.shell?.id ?? null,
      textPartId: args.textPartId,
      mode,
      requestedBy: decision.requestedBy,
      status: 'scripted',
      spokenText,
      synthesisText: clippedSynthesis,
      delivery: delivery as unknown as Record<string, unknown>,
      naturalness: { accepted: true },
      provider: this.deps.capabilities.ttsProvider()?.name ?? null
    });
    this.emit('voice.script.completed', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: args.shell?.id ?? null, mode, status: 'scripted' });

    // 5. Synthesize (cancellable). The controller stored in `active` IS the
    // one handed to the provider, so cancel(id) really stops the request (C3);
    // the reply signal is forwarded into it so a superseded generation stops
    // too. No second controller that cancel() cannot reach.
    const combined = new AbortController();
    this.active.set(generation.id, combined);
    const forward = () => combined.abort(signal.reason);
    if (signal.aborted) combined.abort(signal.reason);
    else signal.addEventListener('abort', forward, { once: true });
    try {
      this.deps.voice.update(generation.id, { status: 'synthesizing', started_at: new Date().toISOString() });
      this.emit('voice.synthesis.started', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: args.shell?.id ?? null, mode, status: 'synthesizing' });
      const provider = this.deps.capabilities.ttsProvider();
      let audio: Awaited<ReturnType<typeof provider.synthesize>> | null = null;
      let lastError: unknown;
      for (let attempt = 0; attempt <= this.flags.ttsRetries; attempt++) {
        if (attempt > 0) this.deps.voice.update(generation.id, { retry_count: attempt });
        try {
          audio = await provider.synthesize(clippedSynthesis, { ...ttsOptions, signal: combined.signal });
          break;
        } catch (err) {
          if (signal.aborted || combined.signal.aborted) throw err;
          lastError = err;
          if (attempt < this.flags.ttsRetries) await abortableDelay(400 * (attempt + 1), combined.signal);
        }
      }
      if (!audio) throw lastError ?? new Error('tts failed');
      if (signal.aborted) throw signal.reason;

      // C4: re-check the revision fence before any persistence; a stale TTS
      // must never attach audio to a reply it no longer belongs to.
      if (this.isStale(args)) {
        this.markSuperseded(generation.id, { batchId: args.batchId, revision: args.revision, messageId: args.shell?.id ?? null }, mode);
        throw new StaleGenerationError('voice revision stale before media.save');
      }
      const media = await this.deps.media.save({
        kind: 'audio',
        origin: 'generated',
        data: audio.data,
        declaredMime: audio.mime,
        filename: `voice.${audio.format}`,
        durationHint: audio.durationSec ?? null,
        transcript: spokenText,
        meta: { tts: true, voiceMode: mode, requestedBy: decision.requestedBy }
      });
      if (signal.aborted) throw signal.reason;
      if (this.isStale(args)) {
        this.markSuperseded(generation.id, { batchId: args.batchId, revision: args.revision, messageId: args.shell?.id ?? null }, mode);
        throw new StaleGenerationError('voice revision stale before publish');
      }

      // 6. Publish per mode.
      const clipped = wasClipped;
      const meta: VoicePartMeta = {
        voiceMode: mode,
        requestedBy: decision.requestedBy,
        emotion: delivery.primaryEmotion,
        pace: delivery.pace,
        generatedFromTextPartId: args.textPartId,
        targetMessageId: null,
        synthesisChars: clippedSynthesis.length,
        fullTranscriptAvailable: true,
        voiceGenerationId: generation.id,
        ...(clipped ? { clipped: true, spokenChars: clippedSynthesis.length } : {})
      };
      let partId: string | null = null;
      let targetShell = args.shell;
      if (mode === 'replace' && !targetShell) {
        // C5: hidden draft — nothing was visible; open the barrier and create
        // the shell only now that the audio is ready.
        targetShell = args.openShell ? await args.openShell() : null;
        if (!targetShell) throw new StaleGenerationError('voice publish barrier lost');
      }
      if (!targetShell) throw new StaleGenerationError('voice publish target shell missing');
      if (mode === 'read_aloud' && args.textPartId) {
        // Attach to the existing text part; no new bubble.
        const part = targetShell.content.find((p) => p.id === args.textPartId);
        const existingMeta = { ...(part?.meta ?? {}) };
        this.deps.messages.updatePart(args.textPartId, { meta: { ...existingMeta, readAloudMediaId: media.id, readAloudDuration: audio.durationSec ? Math.round(audio.durationSec) : null } });
        partId = args.textPartId;
      } else if (mode === 'replace') {
        // Remove the hidden text: the transcript is the copy.
        if (args.textPartId) this.deps.messages.deletePart(args.textPartId);
        partId = this.deps.messages.appendPart(targetShell.id, { type: 'audio', mediaId: media.id, status: 'sent', duration: audio.durationSec ? Math.round(audio.durationSec) : null, transcript: spokenText, meta: { ...meta } });
      } else {
        partId = this.deps.messages.appendPart(targetShell.id, { type: 'audio', mediaId: media.id, status: 'sent', duration: audio.durationSec ? Math.round(audio.durationSec) : null, transcript: spokenText, meta: { ...meta } });
      }
      this.deps.voice.update(generation.id, { status: 'published', media_id: media.id, message_id: targetShell.id, text_part_id: partId ?? args.textPartId ?? null, completed_at: new Date().toISOString() });
      this.emit('voice.published', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: targetShell.id, mode, status: 'published', mediaId: media.id, partId });
      return { ok: true, degraded, partId, mediaId: media.id, generationId: generation.id, shellId: targetShell.id };
    } catch (err) {
      const cancelledByUser = combined.signal.aborted && !signal.aborted;
      if (signal.aborted || cancelledByUser) {
        this.deps.voice.update(generation.id, { status: cancelledByUser ? 'cancelled' : 'superseded', failed_at: new Date().toISOString(), failure_code: cancelledByUser ? 'cancelled' : 'superseded' });
        this.emit(cancelledByUser ? 'voice.cancelled' : 'voice.generation.superseded', {
          voiceGenerationId: generation.id,
          batchId: args.batchId,
          revision: args.revision,
          messageId: args.shell?.id ?? null,
          mode,
          status: cancelledByUser ? 'cancelled' : 'superseded'
        });
        throw err;
      }
      console.error('PROBE synthesis err:', (err as Error)?.name, (err as Error)?.message, 'combined.aborted=', combined.signal.aborted, 'signal.aborted=', signal.aborted);
      return this.handleSynthesisFailure(generation.id, mode, args, spokenText, maxChars, err, degraded);
    } finally {
      this.active.delete(generation.id);
      signal.removeEventListener('abort', forward);
    }
  }

  private guardAccepts(script: VoiceScript, text: string, mode: VoiceMode, maxSeconds: number): boolean {
    if (mode === 'read_aloud') return true;
    return assessNaturalness(script.spokenText, text, mode, { maxVoiceSeconds: maxSeconds }).accepted;
  }

  /** Degrades an unacceptable script: rules-based collapse for replace, rules summary for others. */
  private degradeScript(script: VoiceScript, text: string, mode: VoiceMode, maxChars: number): VoiceScript | null {
    // Replace carries the whole answer: the transcript is the user's only copy,
    // so it must never be trimmed to fit a clip — the synthesis clip handles
    // TTS length, the stored script stays complete.
    const candidate = mode === 'replace'
      ? text.trim()
      : ruleBasedColloquial(mode === 'summary' ? text : script.spokenText, maxChars);
    if (!candidate.trim()) return null;
    return {
      spokenText: candidate,
      mode,
      purpose: mode === 'summary' ? 'short_summary' : 'full_answer',
      estimatedSeconds: estimateSpeechSeconds(candidate),
      semanticClaims: [],
      styleTags: ['rule-degraded']
    };
  }

  private async generateScript(
    text: string,
    mode: VoiceMode,
    userText: string,
    maxSeconds: number,
    signal: AbortSignal,
    attempt: number,
    reportReasons?: string[]
  ): Promise<VoiceScript | null> {
    const caps = this.deps.capabilities;
    if (!caps.has('chat')) return null;
    const provider = caps.chatProvider();
    const persona = this.deps.config.getPersona();
    const styleHints = stylePromptHints(this.speechStyle);
    const prompt = [
      `你是${persona.name}。下面是你刚在聊天里写的一段文字回复。请把它改写成「语音消息的口语脚本」——就像按住语音键自然说话，不是念稿。`,
      `【用户这轮说的话】\n${(userText || '（用户这轮没有发文字）').slice(0, 1500)}\n`,
      `【你已经确定的回复内容】\n${text.slice(0, 2500)}\n`,
      `【语音模式】${MODE_PROMPT[mode]}`,
      `要求：短句；一次只表达一个重点；不要标题、列表、Markdown、链接；不要逐句复述原文；不要堆砌「嗯、啊、那个」；不要广播腔或客服腔。`,
      `事实只能来自上面【你已经确定的回复内容】，不要编造、补充或承诺任何新信息。`,
      styleHints,
      `时长上限约 ${maxSeconds} 秒（中文约每秒 4-5 字）。`,
      ...(attempt > 0 && reportReasons?.length ? [`上一版没有通过自然度检查，原因：${reportReasons.join('；')}。请针对这些问题重写。`] : []),
      `只输出脚本本身，不要任何解释或前后缀。`
    ].join('\n');
    try {
      const result = await provider.complete({
        system: persona.systemPrompt,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: Math.min(1000, Math.max(200, Math.round(text.length * 1.6))),
        temperature: 0.9,
        signal
      });
      const spoken = (result.text ?? '').trim();
      if (!spoken) return null;
      return {
        spokenText: spoken,
        mode,
        purpose: mode === 'replace' ? 'full_answer' : mode === 'summary' ? 'short_summary' : 'emotional_support',
        estimatedSeconds: estimateSpeechSeconds(spoken),
        semanticClaims: [],
        styleTags: []
      };
    } catch (err) {
      if (signal.aborted) throw err;
      this.deps.errorLog.add('voice.script', 'script_generation_failed', { diagnostic: redactDiagnostic(err as Error) });
      return null;
    }
  }

  private async handleSynthesisFailure(
    generationId: string,
    mode: VoiceMode,
    args: InlineVoiceArgs,
    spokenText: string,
    maxChars: number,
    err: unknown,
    degraded: string[]
  ): Promise<InlineVoiceResult> {
    const e = err as Error;
    const isTimeout = e instanceof HttpTimeoutError;
    const failureCode = isTimeout ? 'tts_timeout' : 'tts_failed';
    const reason = e instanceof Error && e.name === 'ProviderNotConfiguredError'
      ? '语音合成服务没有配置。'
      : isTimeout
        ? '语音生成超时。'
        : '语音生成失败。';
    this.deps.voice.update(generationId, {
      status: 'failed',
      failed_at: new Date().toISOString(),
      failure_code: failureCode
    });
    this.emit('voice.synthesis.failed', {
      voiceGenerationId: generationId,
      batchId: args.batchId,
      revision: args.revision,
      messageId: args.shell?.id ?? null,
      mode,
      status: 'failed',
      failureCode
    });
    this.deps.errorLog.add('voice.tts', failureCode, { diagnostic: redactDiagnostic(e) });

    if (mode === 'replace') {
      // Fall back to publishing the spoken script as plain text (C5): for a
      // hidden draft this is the first time the shell appears, carrying text
      // instead of audio — no empty bubble, no visible-then-vanished text.
      // Never lose content: when the script was clipped/degraded shorter than
      // the actual reply, restore the full reply text instead.
      const script = spokenText.trim();
      const final = (args.finalText ?? '').trim();
      const fallbackText = script.length >= final.length ? script : final || script;
      let targetShell = args.shell;
      if (!targetShell && args.openShell) targetShell = await args.openShell();
      if (!targetShell) return { ok: false, degraded: [...degraded, 'audio:provider_unavailable'], partId: null, mediaId: null, generationId, shellId: null };
      const partId = this.deps.messages.appendPart(targetShell.id, {
        type: 'text',
        text: fallbackText,
        status: 'sent',
        meta: { voiceFallback: true, voiceMode: 'replace' }
      });
      this.deps.voice.update(generationId, { message_id: targetShell.id, text_part_id: partId });
      degraded.push('audio:provider_unavailable');
      this.emit('voice.published', {
        voiceGenerationId: generationId,
        batchId: args.batchId,
        revision: args.revision,
        messageId: targetShell.id,
        mode,
        status: 'published-as-text',
        partId
      });
      return { ok: true, degraded, partId, mediaId: null, generationId, shellId: targetShell.id };
    }
    // complement / summary / read_aloud: the text reply stands on its own.
    degraded.push('audio:provider_unavailable');
    return { ok: false, degraded, partId: null, mediaId: null, generationId, shellId: null };
  }

  private emit(type: StreamEventType, payload: Record<string, unknown>): void {
    this.deps.bus.publish(type, payload);
  }

  /**
   * read_aloud API: read an existing text part aloud without creating a new
   * message. Returns the generation id (null when TTS is not configured).
   */
  async readAloud(messageId: string, partId: string): Promise<{ generationId: string | null; ok: boolean; error?: string }> {
    if (!this.flags.readAloud) return { generationId: null, ok: false, error: 'read_aloud_disabled' };
    const message = this.deps.messages.get(messageId);
    const part = message?.content.find((p) => p.id === partId);
    if (!message || !part || part.type !== 'text' || !part.text) {
      return { generationId: null, ok: false, error: 'target_text_not_found' };
    }
    const caps = this.deps.capabilities;
    if (!caps.has('tts')) return { generationId: null, ok: false, error: 'tts_not_configured' };
    const persona = this.deps.config.getPersona();
    const { spokenText, synthesisText } = normalizeVoiceText(part.text);
    if (!synthesisText.trim()) return { generationId: null, ok: false, error: 'empty_text' };
    const delivery = planDelivery(null);
    const emotions = this.deps.settings.get<VoiceEmotionMap>('voice.emotions', DEFAULT_VOICE_EMOTIONS);
    const ttsOptions = deliveryToTTSOptions(delivery, emotions, {
      advanced: this.flags.advancedDelivery,
      customPresets: this.deps.settings.has('voice.emotions')
    });
    const generation = this.deps.voice.create({
      messageId,
      textPartId: partId,
      mode: 'read_aloud',
      requestedBy: 'user',
      status: 'synthesizing',
      spokenText,
      synthesisText,
      delivery: delivery as unknown as Record<string, unknown>,
      provider: caps.ttsProvider()?.name ?? null
    });
    const controller = new AbortController();
    this.active.set(generation.id, controller);
    try {
      const audio = await caps.ttsProvider().synthesize(synthesisText, { ...ttsOptions, signal: controller.signal });
      const media = await this.deps.media.save({
        kind: 'audio',
        origin: 'generated',
        data: audio.data,
        declaredMime: audio.mime,
        filename: `voice.${audio.format}`,
        durationHint: audio.durationSec ?? null,
        transcript: spokenText,
        meta: { tts: true, voiceMode: 'read_aloud', requestedBy: 'user' }
      });
      const existingMeta = { ...(part.meta ?? {}) };
      this.deps.messages.updatePart(partId, {
        meta: { ...existingMeta, readAloudMediaId: media.id, readAloudDuration: audio.durationSec ? Math.round(audio.durationSec) : null }
      });
      this.deps.voice.update(generation.id, { status: 'published', media_id: media.id, completed_at: new Date().toISOString() });
      this.emit('voice.published', { voiceGenerationId: generation.id, messageId, partId, mode: 'read_aloud', status: 'published', mediaId: media.id });
      return { generationId: generation.id, ok: true };
    } catch (err) {
      this.deps.voice.update(generation.id, { status: 'failed', failed_at: new Date().toISOString(), failure_code: 'tts_failed' });
      this.emit('voice.synthesis.failed', { voiceGenerationId: generation.id, messageId, partId, mode: 'read_aloud', status: 'failed' });
      throw err;
    } finally {
      this.active.delete(generation.id);
    }
  }

  /** Manual retry: re-synthesize the last failed voice generation of a message. */
  async retryVoice(messageId: string): Promise<{ generationId: string | null; ok: boolean }> {
    const message = this.deps.messages.get(messageId);
    if (!message) return { generationId: null, ok: false };
    const latest = this.deps.voice.latestForMessage(messageId);
    const mode = (latest?.mode ?? 'complement') as VoiceMode;
    const textPart = message.content.find((p) => p.type === 'text' && p.status === 'sent' && !p.meta?.voiceFallback);
    const audio = message.content.find((p) => p.type === 'audio');
    const finalText = textPart?.text ?? latest?.spoken_text ?? message.content.find((p) => p.type === 'text')?.text ?? '';
    if (!finalText.trim()) return { generationId: null, ok: false };
    const batchId = (message.meta?.batchId as string | undefined) ?? null;
    const revision = latest?.revision ?? 0;
    const result = await this.synthesizeInlineVoice({
      batchId: batchId ?? 'retry',
      revision,
      shell: message,
      textPartId: textPart?.id ?? null,
      finalText,
      userText: '',
      decision: { mode: mode === 'read_aloud' ? 'read_aloud' : mode, requestedBy: 'user', emotion: null, reason: 'retry' },
      modelEmotion: null,
      signal: new AbortController().signal,
      persona: this.deps.config.getPersona()
    });
    return { generationId: result.generationId, ok: result.ok };
  }

  /** Cancel an in-flight (not yet published) voice generation. */
  cancel(id: string): boolean {
    const controller = this.active.get(id);
    if (!controller) return false;
    controller.abort(new Error('cancelled by user'));
    return true;
  }
}
