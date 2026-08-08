/**
 * ThoughtsService — the wiring point for the visible-thoughts layer.
 *
 * Implements ThoughtsBridge for the ReplyCoordinator and exposes the read
 * surface used by the routes:
 *
 *   - beginForReply: after a reply is fully published, records the admin
 *     decision trace (ADMIN_DECISION_TRACE_ENABLED) and kicks off the
 *     user-visible inner monologue (VISIBLE_INNER_MONOLOGUE_ENABLED),
 *     fire-and-forget — a slow or failing thought model never delays or
 *     breaks the reply.
 *   - onUserActivity: a newer user message (or shutdown) cancels every
 *     still-generating thought through the DB fence.
 *
 * All feature flags default OFF: an unset flag means this service does
 * nothing at all (no rows, no model calls, no events).
 */

import type { ChatMessage } from '../types.js';
import type { ThoughtsBridge } from './bridge.js';
import type { ThoughtsFlags } from './flags.js';
import type { ThoughtRepo } from '../../db/repos/thought.repo.js';
import type { ThoughtPresenter, ThoughtPrepareInput } from './presenter.js';
import type { MessageRepo } from '../../db/repos/message.repo.js';
import type { ErrorLogRepo } from '../../db/repos/misc.repo.js';
import type { VisibleThought } from './types.js';
import { classifyReplyIntent, semanticGuardFrom, type ThoughtContextProvider } from './context.js';

export interface ThoughtsServiceOptions {
  flags: ThoughtsFlags;
  repo: ThoughtRepo;
  presenter: ThoughtPresenter;
  /** Whitelist of safe context the thought may read (world/life/voice/memory stats). */
  context: ThoughtContextProvider;
  messages?: MessageRepo | null;
  errorLog?: ErrorLogRepo;
}

export class ThoughtsService implements ThoughtsBridge {
  private readonly active = new Map<string, AbortController>();

  constructor(private readonly deps: ThoughtsServiceOptions) {}

  // ---- ThoughtsBridge (called by the coordinator) ----

  beginForReply(input: { batchId: string; revision: number; messageId: string; userMessages: ChatMessage[]; finalReply: string; degraded: string[] }): void {
    if (!this.deps.flags.visibleThoughtsEnabled) return;
    const key = `${input.batchId}:${input.revision}`;
    try {
      if (!this.deps.flags.innerMonologueEnabled) return;
      const controller = new AbortController();
      this.active.set(key, controller);
      const prepared: ThoughtPrepareInput = {
        batchId: input.batchId,
        revision: input.revision,
        messageId: input.messageId,
        userMessage: latestUserText(input.userMessages),
        finalReply: input.finalReply,
        safeLifeContext: this.safeLifeContext(),
        safeWorldContext: this.safeWorldContext(),
        replyIntent: classifyReplyIntent(latestUserText(input.userMessages)) ?? null,
        voiceMode: this.voiceMode(input.messageId),
        decisionMetadata: this.decisionMetadata(input),
        signal: controller.signal
      };
      void this.deps.presenter
        .prepare(prepared)
        .catch(() => {
          // The presenter already swallows model/safety problems; this is the
          // last line so a thought can never take down the reply path.
          this.deps.errorLog?.add('thoughts.service', 'prepare_unexpected_failure', {
            batchId: input.batchId,
            revision: input.revision
          });
        })
        .finally(() => this.active.delete(key));
    } catch (error) {
      this.active.delete(key);
      this.deps.errorLog?.add('thoughts.service', 'begin_failed', {
        batchId: input.batchId,
        revision: input.revision,
        message: String((error as Error)?.message ?? error).slice(0, 500)
      });
    }
  }

  onUserActivity(): void {
    if (!this.deps.flags.visibleThoughtsEnabled) return;
    try {
      for (const controller of this.active.values()) {
        controller.abort(new Error('user_activity'));
      }
      this.active.clear();
      // The DB fence is the source of truth: even a thought whose model call
      // is not tracked here (e.g. started by another worker) gets cancelled.
      this.deps.repo.cancelOpenThoughts();
    } catch (error) {
      this.deps.errorLog?.add('thoughts.service', 'cancel_failed', {
        message: String((error as Error)?.message ?? error).slice(0, 500)
      });
    }
  }

  // ---- Read surface (routes) ----

  getUserThought(messageId: string): VisibleThought | null {
    return this.deps.repo.getUserThought(messageId) ?? null;
  }

  getThoughtsForMessage(messageId: string): VisibleThought[] {
    return this.deps.repo.getByMessage(messageId);
  }

  // ---- context gathering (whitelist only) ----

  private safeWorldContext(): string[] {
    const world = this.deps.context.worldSnapshot();
    if (!world) return [];
    const lines: string[] = [];
    if (world.timeZone) lines.push(`timeZone: ${world.timeZone}`);
    const place = world.location?.city ?? world.location?.name ?? world.location?.id;
    if (place) lines.push(`location: ${place}`);
    if (world.weatherCondition) lines.push(`weather: ${world.weatherCondition}`);
    return lines;
  }

  private safeLifeContext(): string[] {
    const life = this.deps.context.lifeSummary();
    if (!life) return [];
    const lines: string[] = [];
    if (life.activity) lines.push(`activity: ${life.activity}`);
    if (life.mood) lines.push(`mood: ${life.mood}`);
    return lines;
  }

  private voiceMode(messageId: string): string | null {
    return this.deps.context.voiceRowFor(messageId)?.mode ?? null;
  }

  private decisionMetadata(input: { batchId: string; revision: number; messageId: string; degraded: string[] }): ThoughtPrepareInput['decisionMetadata'] {
    const memoryRecallCount = this.deps.context.memoryRecallStats()?.stats.recalled;
    const voiceRow = this.deps.context.voiceRowFor(input.messageId);
    const semanticGuard = semanticGuardFrom(
      { ...input, voiceFallbackReason: this.voiceFallbackReason(input.messageId) },
      voiceRow
    );
    if (memoryRecallCount === undefined && semanticGuard === undefined) return null;
    return { memoryRecallCount, semanticGuard: semanticGuard ?? null };
  }

  private voiceFallbackReason(messageId: string): string | null {
    try {
      const message = this.deps.messages?.get(messageId);
      if (!message) return null;
      for (const part of message.content) {
        if (part.type === 'text' && typeof part.meta?.voiceFallbackReason === 'string') {
          return part.meta.voiceFallbackReason;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

function latestUserText(userMessages: ChatMessage[]): string {
  for (const message of [...userMessages].reverse()) {
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
      .join(' ')
      .trim();
    if (text) return text;
  }
  return '';
}
