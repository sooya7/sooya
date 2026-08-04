import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';

let h: Harness;
afterEach(async () => {
  if (h) await h.cleanup();
});

async function seed(harness: Harness, contents: string[]): Promise<void> {
  for (const [i, content] of contents.entries()) {
    harness.app.repos.memories.upsert({ kind: 'profile', content, importance: 0.5 + i * 0.01 });
    // All seeded memories get vectors so the embedding recall path is used.
    await harness.app.services.memory.backfillEmbeddings(50);
  }
}

describe('rerank stage in recall', () => {
  it('reorders vector candidates by reranker verdict and marks matches reranked', async () => {
    h = await createHarness({
      embedding: 'ok',
      embeddingDim: 8,
      rerank: 'ok',
      // Rank the sleep memory first regardless of its cosine position: the
      // final order must follow the reranker, not the vector scores.
      rerankOrder: (docs) => {
        const first = docs.findIndex((d) => d.includes('熬夜'));
        return docs.map((_, i) => i).sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
      }
    });
    await seed(h, ['用户喜欢在雨天看书', '用户每天晚上熬夜不睡觉', '用户养过一只仓鼠']);
    const recall = await h.app.services.memory.recall('熬夜不睡觉', 8);
    expect(recall.strategy).toBe('embedding');
    expect(h.state.rerankCalls).toBe(1);
    expect(recall.memories[0]!.content).toBe('用户每天晚上熬夜不睡觉');
    expect(recall.matches[0]!.reason).toContain('reranked');
  });

  it('falls back to pure vector ordering when the reranker fails', async () => {
    h = await createHarness({ embedding: 'ok', embeddingDim: 8, rerank: 'fail' });
    await seed(h, ['用户喜欢喝美式咖啡', '用户住在杭州']);
    const recall = await h.app.services.memory.recall('咖啡', 8);
    expect(recall.strategy).toBe('embedding');
    expect(recall.memories[0]!.content).toContain('咖啡');
    expect(recall.matches.every((m) => !m.reason.includes('reranked'))).toBe(true);
  });

  it('never calls the reranker when it is not configured', async () => {
    h = await createHarness({ embedding: 'ok', embeddingDim: 8, rerank: 'off' });
    await seed(h, ['用户喜欢喝美式咖啡']);
    const recall = await h.app.services.memory.recall('咖啡', 8);
    expect(recall.strategy).toBe('embedding');
    expect(h.state.rerankCalls).toBe(0);
  });
});
