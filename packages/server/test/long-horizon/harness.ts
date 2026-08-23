import { createHarness, sendText, type Harness } from '../helpers/harness.js';
import type { SooyaApp } from '../../src/app.js';

/**
 * Long-horizon harness (plan §25): a deterministic clock the scenarios own,
 * one scripted model response per call, and helpers to advance time and run
 * the time-driven commitment lifecycle. Per user turn the model is called in
 * this order: reply → memory extract (for non-trivial text) → post-turn
 * analyzer; scenarios queue exactly those responses.
 */
export interface TurnScript {
  reply?: string;
  /** Raw memory-extraction JSON; defaults to "nothing worth remembering". */
  memoryExtract?: string;
  /** Raw analyzer JSON for this turn's future.analyze call. */
  analyzer?: string;
}

export interface FutureHarness {
  app: SooyaApp;
  raw: Harness;
  setNow(iso: string): void;
  now(): Date;
  /** Send one user turn and drain all post-turn jobs before returning. */
  turn(userText: string, scripts: TurnScript): Promise<{ userMessageId: string }>;
  /** Advance the clock and run the §13 time-driven lifecycle at that instant. */
  advanceAndTick(iso: string): void;
}

export async function createFutureHarness(
  startAt = '2026-08-19T02:00:00.000Z',
  extraEnv: Record<string, string> = {}
): Promise<FutureHarness> {
  let simulated = new Date(startAt);
  const raw = await createHarness({
    embedding: 'off',
    clock: () => simulated,
    env: { FUTURE_ENGINE_ENABLED: 'true', ...extraEnv }
  });

  return {
    app: raw.app,
    raw,
    setNow: (iso: string) => {
      simulated = new Date(iso);
    },
    now: () => simulated,
    async turn(userText: string, scripts: TurnScript) {
      const queue: string[][] = [[scripts.reply ?? '好的。']];
      if (memoryExtractionRuns(userText)) queue.push([scripts.memoryExtract ?? '{"worth":false,"items":[]}']);
      if (scripts.analyzer !== undefined) queue.push([scripts.analyzer]);
      raw.setChatScript(queue);
      const { body } = await sendText(raw.app, userText);
      await raw.app.services.worker.drain();
      return { userMessageId: String(body.message?.id ?? '') };
    },
    advanceAndTick(iso: string) {
      simulated = new Date(iso);
      raw.app.services.future.tick(simulated);
    }
  };
}

/** Mirrors MemoryService.worthConsidering for the phrase shapes scenarios use. */
function memoryExtractionRuns(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  return !/^(嗯+|哦+|好的?|哈+|ok|okay|谢谢|在吗|你好|hi|hello|晚安|早安)[。.!！~\s]*$/i.test(t);
}
