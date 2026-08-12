import { describe, expect, it, vi } from 'vitest';
import { ThoughtPresenter } from '../src/core/thoughts/presenter.js';
import { ThoughtSafetyFilter } from '../src/core/thoughts/safety.js';
import type { ThoughtRepo, ThoughtCreateInput } from '../src/db/repos/thought.repo.js';
import type { VisibleThought } from '../src/core/thoughts/types.js';
import type { ChatProvider } from '../src/providers/types.js';

class FakeThoughtRepo {
  private readonly rows = new Map<string, VisibleThought>();
  private seq = 0;

  create(input: ThoughtCreateInput): VisibleThought {
    const row: VisibleThought = {
      id: `t${++this.seq}`,
      messageId: input.messageId,
      batchId: input.batchId,
      revision: input.revision,
      kind: input.kind,
      text: '',
      visibility: input.visibility,
      status: 'generating',
      createdAt: new Date(0).toISOString()
    };
    this.rows.set(row.id, row);
    return { ...row };
  }

  get(id: string): VisibleThought | undefined {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }

  completeThought(id: string, text: string): boolean {
    const row = this.rows.get(id);
    if (!row || row.status !== 'generating') return false;
    this.rows.set(id, { ...row, status: 'completed', text });
    return true;
  }

  failThought(id: string): boolean {
    const row = this.rows.get(id);
    if (!row || row.status !== 'generating') return false;
    this.rows.set(id, { ...row, status: 'failed', text: '' });
    return true;
  }
}

function providerWith(outputs: string[]): { provider: ChatProvider; complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async () => ({ text: outputs.shift() ?? '', model: 'test' }));
  const provider = {
    name: 'test',
    configured: true,
    complete,
    stream: vi.fn(),
    inspectHealth: vi.fn()
  } as unknown as ChatProvider;
  return { provider, complete };
}

const input = {
  batchId: 'b1',
  revision: 1,
  messageId: 'm1',
  userMessage: '你在想什么？',
  finalReply: '没什么呀。',
  safeLifeContext: [],
  safeWorldContext: [],
  replyIntent: null,
  voiceMode: null
};

describe('ThoughtPresenter malformed-output retry', () => {
  it('retries once and publishes the repaired thought', async () => {
    const repo = new FakeThoughtRepo();
    const { provider, complete } = providerWith(['Won', '有点想逗逗他。']);
    const presenter = new ThoughtPresenter({
      repo: repo as unknown as ThoughtRepo,
      chat: provider,
      safety: new ThoughtSafetyFilter(),
      timeoutMs: 1000
    });

    const result = await presenter.prepare(input);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.monologue?.status).toBe('completed');
    expect(result.monologue?.text).toBe('有点想逗逗他。');
  });

  it('drops the thought when both attempts are malformed', async () => {
    const repo = new FakeThoughtRepo();
    const { provider, complete } = providerWith(['(心', 'Won']);
    const presenter = new ThoughtPresenter({
      repo: repo as unknown as ThoughtRepo,
      chat: provider,
      safety: new ThoughtSafetyFilter(),
      timeoutMs: 1000
    });

    const result = await presenter.prepare(input);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.monologue?.status).toBe('failed');
    expect(result.monologue?.text).toBe('');
  });
});
