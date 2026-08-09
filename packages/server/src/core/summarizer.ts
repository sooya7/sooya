import type { MessageRepo } from '../db/repos/message.repo.js';
import type { SummaryRepo, ErrorLogRepo } from '../db/repos/misc.repo.js';
import type { CapabilityRegistry } from './capabilities.js';
import { renderMessageForSummary } from './web-search/isolation.js';

const SUMMARY_PROMPT = `把下面这段聊天压缩成简洁的中文要点，保留：用户说过的事实、约定、情绪走向、未完成的事。
不要复述寒暄，不要加入你的评价，不超过 200 字。直接输出要点文字。`;

export interface SummaryOutcome {
  created: boolean;
  reason?: string;
  fromSeq?: number;
  toSeq?: number;
}

/**
 * Segmented, versioned conversation summaries.
 * A range is summarized at most once (`coveredUpTo` moves forward monotonically),
 * original messages are never deleted, and a failure is non-fatal.
 */
export class Summarizer {
  private running = false;

  constructor(
    private readonly messages: MessageRepo,
    private readonly summaries: SummaryRepo,
    private readonly capabilities: CapabilityRegistry,
    private readonly errorLog: ErrorLogRepo,
    private readonly opts: { triggerMessages: number; chunkMessages: number; keepRecent: number }
  ) {}

  /** True when there is an unsummarized backlog beyond the recent window. */
  needsSummary(): boolean {
    const maxSeq = this.messages.maxSeq();
    const covered = this.summaries.coveredUpTo();
    return maxSeq - covered - this.opts.keepRecent >= this.opts.triggerMessages;
  }

  async runOnce(signal?: AbortSignal): Promise<SummaryOutcome> {
    if (this.running) return { created: false, reason: 'already running' };
    if (!this.needsSummary()) return { created: false, reason: 'not needed' };
    const provider = this.capabilities.summaryProvider();
    if (!provider.configured) return { created: false, reason: 'summary model not configured' };

    this.running = true;
    try {
      const covered = this.summaries.coveredUpTo();
      const maxSeq = this.messages.maxSeq();
      const fromSeq = covered + 1;
      const toSeq = Math.min(fromSeq + this.opts.chunkMessages - 1, maxSeq - this.opts.keepRecent);
      if (toSeq < fromSeq) return { created: false, reason: 'nothing to summarize' };
      const range = this.messages.range(fromSeq, toSeq);
      if (range.length === 0) {
        // Range is empty (messages deleted): still advance so we never loop.
        this.summaries.create({ fromSeq, toSeq, content: '（该段没有可用消息）', model: null });
        return { created: true, fromSeq, toSeq };
      }
      const transcript = range.map(renderMessageForSummary).filter(Boolean).join('\n').slice(0, 12000);
      const result = await provider.complete({
        system: SUMMARY_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
        maxTokens: 400,
        temperature: 0.2,
        signal
      });
      const content = result.text.trim();
      if (!content) return { created: false, reason: 'summary model returned empty text' };
      this.summaries.create({ fromSeq, toSeq, content, model: result.model });
      return { created: true, fromSeq, toSeq };
    } catch (err) {
      this.errorLog.add('summary', (err as Error).message);
      return { created: false, reason: (err as Error).message };
    } finally {
      this.running = false;
    }
  }
}

