/**
 * Media intents staged by the media tools during a reply's tool round.
 *
 * Same contract as the file drafts (core/files/drafts.ts): a tool call only
 * records what this reply should carry, keyed by `${batchId}:${revision}`. The
 * reply generator folds the staged intent into the directives it already
 * understands, so nothing downstream (image, video, TTS, QQ delivery) changes.
 * A generation that is superseded never publishes, so its stage is simply
 * forgotten - entries are pruned after an hour, like the file stages.
 */
import type { ModelDirectives } from '../directives.js';

export interface StagedMediaIntent {
  imagePrompt?: string;
  videoPrompt?: string;
  voice?: boolean;
  voiceOnly?: boolean;
  voiceEmotion?: string;
}

interface StageContext {
  batchId?: string;
  revision?: number;
}

interface Stage {
  intent: StagedMediaIntent;
  createdAt: number;
}

/** How long a stage nobody consumed is kept before it is dropped. */
export const MEDIA_INTENT_STAGE_TTL_MS = 60 * 60 * 1000;

export class MediaIntentStage {
  private readonly stages = new Map<string, Stage>();

  constructor(private readonly now: () => number = Date.now) {}

  private keyOf(ctx: StageContext): string {
    if (ctx.batchId === undefined || ctx.revision === undefined) {
      throw new Error('media tools only work while replying');
    }
    return `${ctx.batchId}:${ctx.revision}`;
  }

  /** Folds one tool call into this reply's staged intent; named fields overwrite. */
  stage(ctx: StageContext, patch: StagedMediaIntent): StagedMediaIntent {
    const key = this.keyOf(ctx);
    const existing = this.stages.get(key);
    const intent: StagedMediaIntent = { ...(existing?.intent ?? {}), ...patch };
    if (!existing) this.prune();
    this.stages.set(key, { intent, createdAt: existing?.createdAt ?? this.now() });
    return intent;
  }

  /** What this generation staged so far, without consuming it. */
  peek(ctx: StageContext): StagedMediaIntent | null {
    return this.stages.get(this.keyOf(ctx))?.intent ?? null;
  }

  /** Reads the staged intent and forgets it: one generation publishes it once. */
  take(ctx: StageContext): StagedMediaIntent | null {
    const key = this.keyOf(ctx);
    const stage = this.stages.get(key);
    if (!stage) return null;
    this.stages.delete(key);
    return stage.intent;
  }

  /** Staged generations that never published (superseded, failed) are forgotten after an hour. */
  prune(): void {
    const cutoff = this.now() - MEDIA_INTENT_STAGE_TTL_MS;
    for (const [key, stage] of this.stages) if (stage.createdAt < cutoff) this.stages.delete(key);
  }

  get size(): number {
    return this.stages.size;
  }
}

/**
 * Folds the tool's intent into the directives. The retired media markers no
 * longer set anything there, so the tool is the only source of these fields.
 */
export function mergeStagedMediaIntent(directives: ModelDirectives, staged: StagedMediaIntent | null): ModelDirectives {
  if (!staged) return directives;
  const merged: ModelDirectives = { ...directives };
  if (staged.imagePrompt) merged.imagePrompt = staged.imagePrompt;
  if (staged.videoPrompt) merged.videoPrompt = staged.videoPrompt;
  if (staged.voice === true || staged.voiceOnly === true) merged.voice = true;
  if (staged.voiceOnly === true) merged.voiceOnly = true;
  if (staged.voiceEmotion) merged.voiceEmotion = staged.voiceEmotion;
  return merged;
}
