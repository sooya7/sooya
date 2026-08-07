import type { MessageRepo } from '../../db/repos/message.repo.js';
import type { VoiceGenerationRepo } from '../../db/repos/voice.repo.js';
import type { MediaStore } from '../../media/store.js';
import type { CapabilityRegistry } from '../capabilities.js';
import type { ConfigStore } from '../../config/store.js';
import type { EventBus } from '../../events/bus.js';
import type { ErrorLogRepo, SettingsRepo } from '../../db/repos/misc.repo.js';
import type { ChatMessage } from '../types.js';
import { HttpTimeoutError } from '../../util/http.js';
import { redactDiagnostic } from '../public-error.js';
import { DEFAULT_VOICE_EMOTIONS, type VoiceEmotionMap } from '../voice.js';
import { planDelivery, deliveryToTTSOptions } from './delivery.js';
import { parseVoiceIntent, mergeVoiceDirectives } from './intent.js';
import { assessNaturalness, estimateSpeechSeconds, voiceTextSimilarity, splitSentences } from './naturalness.js';
import { normalizeVoiceText, ruleBasedColloquial } from './normalize.js';
import { decideVoiceMode, type VoiceDecision } from './planner.js';
import { DEFAULT_SPEECH_STYLE, stylePromptHints, type PersonaSpeechStyle } from './style.js';
import type { UserVoicePreferences, VoiceMode, VoiceRequestedBy, VoiceScript, VoicePartMeta, VoiceDeliveryPlan } from './types.js';
import { DEFAULT_VOICE_PREFERENCES } from './types.js';

export type { VoiceIntent } from './types.js';
export { parseVoiceIntent, mergeVoiceDirectives } from './intent.js';
export { decideVoiceMode } from './planner.js';
export { assessNaturalness, voiceTextSimilarity, estimateSpeechSeconds, splitSentences } from './naturalness.js';
export { normalizeVoiceText, ruleBasedColloquial } from './normalize.js';
export { planDelivery } from './delivery.js';
export type { VoiceDecision, VoiceDeliveryPlan, UserVoicePreferences, VoiceMode, VoiceScript, VoicePartMeta, PersonaSpeechStyle } from './types.js';
export { DEFAULT_VOICE_PREFERENCES } from './types.js';
export { DEFAULT_SPEECH_STYLE, stylePromptHints } from './style.js';

const MODE_PROMPT: Record<VoiceMode, string> = {
  replace: '语音承担完整回答，文字将不显示；要让对方只听语音就能完全明白。',
  complement: '文字已经提供了主要信息，语音只补充更适合用声音表达的关心、态度或温度；不要复述文字内容。',
  summary: '文字较长，语音用自然口语概括重点；保留主结论，不逐条念列表，不要省略关键提醒。',
  read_aloud: '按原文朗读，不改语义。'
};

export interface InlineVoiceArgs {
  batchId: string;
  revision: number;
  shell: ChatMessage;
  textPartId: string | null;
  finalText: string;
  userText: string;
  decision: VoiceDecision;
  modelEmotion: string | null;
  signal: AbortSignal;
  persona: ReturnType<ConfigStore['getPersona']>;
}

export interface InlineVoiceResult {
  ok: boolean;
  degraded: string[];
  partId: string | null;
  mediaId: string | null;
  generationId: string | null;
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
      capabilities: CapabilityRegistry;
      config: ConfigStore;
      settings: SettingsRepo;
      bus: EventBus;
      errorLog: ErrorLogRepo;
    }
  ) {}

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
   * Full inline voice flow, called from the replier's phase 2 (media attach).
   * Returns degraded notes; never throws for provider failures (falls back
   * per mode) — only aborts/stale revisions propagate.
   */
  async synthesizeInlineVoice(args: InlineVoiceArgs): Promise<InlineVoiceResult> {
    const { decision, signal, persona } = args;
    const degraded: string[] = [];
    const maxSeconds = this.speechStyle.maxVoiceSeconds || persona.voicePolicy.maxCharsPerClip / 8;
    const maxChars = persona.voicePolicy.maxCharsPerClip;

    // 1. Script.
    let script: VoiceScript | null = null;
    if (decision.mode === 'read_aloud') {
      script = {
        spokenText: args.finalText,
        mode: 'read_aloud',
        purpose: 'read_aloud',
        estimatedSeconds: estimateSpeechSeconds(args.finalText),
        semanticClaims: [],
        styleTags: ['read-aloud']
      };
    } else {
      script = await this.generateScript(args.finalText, decision.mode, args.userText, maxSeconds, signal, 0);
      if (script && !this.guardAccepts(script, args.finalText, decision.mode, maxSeconds)) {
        const report = assessNaturalness(script.spokenText, args.finalText, decision.mode, { maxVoiceSeconds: maxSeconds });
        // One rewrite with the report.
        script = await this.generateScript(args.finalText, decision.mode, args.userText, maxSeconds, signal, 1, report.reasons);
        if (script && !this.guardAccepts(script, args.finalText, decision.mode, maxSeconds)) {
          script = this.degradeScript(script, args.finalText, decision.mode, maxChars);
          if (!script && decision.mode !== 'replace') {
            return { ok: false, degraded: [...degraded, 'voice:skipped-naturalness'], partId: null, mediaId: null, generationId: null };
          }
        }
      }
      if (!script) {
        if (decision.mode === 'replace') {
          const fallback = ruleBasedColloquial(args.finalText, maxChars);
          script = { spokenText: fallback, mode: 'replace', purpose: 'full_answer', estimatedSeconds: estimateSpeechSeconds(fallback), semanticClaims: [], styleTags: ['rule-fallback'] };
          degraded.push('voice:script-fallback-rules');
        } else {
          return { ok: false, degraded: [...degraded, 'voice:no-script'], partId: null, mediaId: null, generationId: null };
        }
      }
    }

    // 2. Normalize: transcript stays human, synthesis gets cleaned.
    const { spokenText, synthesisText } = normalizeVoiceText(script.spokenText);
    if (!spokenText.trim()) return { ok: false, degraded: [...degraded, 'voice:empty-script'], partId: null, mediaId: null, generationId: null };

    // 3. Delivery.
    const emotion = decision.emotion ?? args.modelEmotion ?? null;
    const delivery = planDelivery(emotion);
    const emotions = this.deps.settings.get<VoiceEmotionMap>('voice.emotions', DEFAULT_VOICE_EMOTIONS);
    const ttsOptions = deliveryToTTSOptions(delivery, emotions);

    // 4. Generation record.
    const generation = this.deps.voice.create({
      batchId: args.batchId,
      revision: args.revision,
      messageId: args.shell.id,
      textPartId: args.textPartId,
      mode: decision.mode,
      requestedBy: decision.requestedBy,
      status: 'scripted',
      spokenText,
      synthesisText,
      delivery: delivery as unknown as Record<string, unknown>,
      naturalness: { accepted: true },
      provider: this.deps.capabilities.ttsProvider()?.name ?? null
    });
    this.emit('voice.script.completed', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: args.shell.id, mode: decision.mode, status: 'scripted' });

    // 5. Synthesize (cancellable).
    this.active.set(generation.id, new AbortController());
    const combined = new AbortController();
    const forward = () => combined.abort(signal.reason);
    if (signal.aborted) combined.abort(signal.reason);
    else signal.addEventListener('abort', forward, { once: true });
    try {
      this.deps.voice.update(generation.id, { status: 'synthesizing', started_at: new Date().toISOString() });
      this.emit('voice.synthesis.started', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: args.shell.id, mode: decision.mode, status: 'synthesizing' });
      const audio = await this.deps.capabilities.ttsProvider().synthesize(synthesisText, { ...ttsOptions, signal: combined.signal });
      if (signal.aborted) throw signal.reason;
      const media = await this.deps.media.save({
        kind: 'audio',
        origin: 'generated',
        data: audio.data,
        declaredMime: audio.mime,
        filename: `voice.${audio.format}`,
        durationHint: audio.durationSec ?? null,
        transcript: spokenText,
        meta: { tts: true, voiceMode: decision.mode, requestedBy: decision.requestedBy }
      });
      if (signal.aborted) throw signal.reason;

      // 6. Publish per mode.
      const clipped = synthesisText.length > maxChars;
      const meta: VoicePartMeta = {
        voiceMode: decision.mode,
        requestedBy: decision.requestedBy,
        emotion: delivery.primaryEmotion,
        pace: delivery.pace,
        generatedFromTextPartId: args.textPartId,
        targetMessageId: null,
        synthesisChars: synthesisText.length,
        clipped,
        fullTranscriptAvailable: true,
        voiceGenerationId: generation.id
      };
      let partId: string | null = null;
      if (decision.mode === 'read_aloud' && args.textPartId) {
        // Attach to the existing text part; no new bubble.
        const part = args.shell.content.find((p) => p.id === args.textPartId);
        const existingMeta = { ...(part?.meta ?? {}) };
        this.deps.messages.updatePart(args.textPartId, { meta: { ...existingMeta, readAloudMediaId: media.id, readAloudDuration: audio.durationSec ? Math.round(audio.durationSec) : null } });
        partId = args.textPartId;
      } else if (decision.mode === 'replace') {
        // Remove the hidden text: the transcript is the copy.
        if (args.textPartId) this.deps.messages.deletePart(args.textPartId);
        partId = this.deps.messages.appendPart(args.shell.id, { type: 'audio', mediaId: media.id, status: 'sent', duration: audio.durationSec ? Math.round(audio.durationSec) : null, transcript: spokenText, meta });
      } else {
        partId = this.deps.messages.appendPart(args.shell.id, { type: 'audio', mediaId: media.id, status: 'sent', duration: audio.durationSec ? Math.round(audio.durationSec) : null, transcript: spokenText, meta });
      }
      this.deps.voice.update(generation.id, { status: 'published', media_id: media.id, completed_at: new Date().toISOString() });
      this.emit('voice.published', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: args.shell.id, mode: decision.mode, status: 'published', mediaId: media.id, partId });
      return { ok: true, degraded, partId, mediaId: media.id, generationId: generation.id };
    } catch (err) {
      if (signal.aborted) {
        this.deps.voice.update(generation.id, { status: 'superseded', failed_at: new Date().toISOString(), failure_code: 'superseded' });
        this.emit('voice.generation.superseded', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: args.shell.id, mode: decision.mode, status: 'superseded' });
        throw err;
      }
      return this.handleSynthesisFailure(generation.id, decision.mode, args, spokenText, maxChars, err, degraded);
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
    const candidate = ruleBasedColloquial(mode === 'summary' ? text : script.spokenText, maxChars);
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
      `模式：${MODE_PROMPT[mode]}`,
      `要求：短句；一次只表达一个重点；不要标题、列表、Markdown、链接；不要逐句复述原文；不要堆砌「嗯、啊、那个」；不要广播腔或客服腔；不要新增任何事实或承诺。`,
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

  private handleSynthesisFailure(
    generationId: string,
    mode: VoiceMode,
    args: InlineVoiceArgs,
    spokenText: string,
    maxChars: number,
    err: unknown,
    degraded: string[]
  ): InlineVoiceResult {
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
      messageId: args.shell.id,
      mode,
      status: 'failed',
      failureCode
    });
    this.deps.errorLog.add('voice.tts', failureCode, { diagnostic: redactDiagnostic(e) });

    if (mode === 'replace') {
      // Fall back to publishing the spoken script as plain text.
      const fallbackText = spokenText.trim() || args.finalText;
      const partId = this.deps.messages.appendPart(args.shell.id, {
        type: 'text',
        text: fallbackText,
        status: 'sent',
        meta: { voiceFallback: true, voiceMode: 'replace' }
      });
      degraded.push('audio:provider_unavailable');
      this.emit('voice.published', {
        voiceGenerationId: generationId,
        batchId: args.batchId,
        revision: args.revision,
        messageId: args.shell.id,
        mode,
        status: 'published-as-text',
        partId
      });
      return { ok: true, degraded, partId, mediaId: null, generationId };
    }
    // complement / summary / read_aloud: the text reply stands on its own.
    degraded.push('audio:provider_unavailable');
    return { ok: false, degraded, partId: null, mediaId: null, generationId };
  }

  private emit(type: StreamEventType, payload: Record<string, unknown>): void {
    this.deps.bus.publish(type, payload);
  }

  /**
   * read_aloud API: read an existing text part aloud without creating a new
   * message. Returns the generation id (null when TTS is not configured).
   */
  async readAloud(messageId: string, partId: string): Promise<{ generationId: string | null; ok: boolean; error?: string }> {
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
    const ttsOptions = deliveryToTTSOptions(delivery, emotions);
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
