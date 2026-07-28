import { describe, it, expect, afterEach } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';

let h: Harness;
afterEach(async () => {
  if (h) await h.cleanup();
});

const EXTRACT = (items: unknown) => JSON.stringify({ worth: true, items });

describe('memory extraction pipeline', () => {
  it('stores extracted memories and records the source message', async () => {
    h = await createHarness({
      embedding: 'ok',
      chat: {
        script: [
          ['知道啦'],
          [EXTRACT([{ kind: 'profile', content: '用户的名字是小明', importance: 0.9, confidence: 0.9 }])]
        ]
      }
    });
    const { body } = await sendText(h.app, '我叫小明，住在上海');
    await h.app.services.worker.drain();
    const memories = h.app.repos.memories.list({});
    expect(memories.length).toBeGreaterThan(0);
    const m = memories[0]!;
    expect(m.content).toContain('小明');
    expect(m.sources).toContain(body.message.id);
    expect(m.createdAt).toBeTruthy();
    expect(m.updatedAt).toBeTruthy();
    expect(m.hasEmbedding).toBe(true);
  });

  it('does not remember trivial chatter', async () => {
    h = await createHarness({ chat: { script: [['嗯嗯'], ['{"worth":false,"items":[]}']] } });
    await sendText(h.app, '嗯');
    await h.app.services.worker.drain();
    expect(h.app.repos.memories.count()).toBe(0);
  });

  it('merges duplicate memories instead of storing them twice', async () => {
    h = await createHarness({
      chat: {
        script: [
          ['好的'],
          [EXTRACT([{ kind: 'preference', content: '用户喜欢喝美式咖啡', importance: 0.6, confidence: 0.7 }])],
          ['好的'],
          [EXTRACT([{ kind: 'preference', content: '用户喜欢喝美式咖啡。', importance: 0.8, confidence: 0.8 }])]
        ]
      }
    });
    await sendText(h.app, '我喜欢喝美式咖啡', 'm1');
    await h.app.services.worker.drain();
    await sendText(h.app, '我真的很喜欢美式', 'm2');
    await h.app.services.worker.drain();
    const memories = h.app.repos.memories.list({});
    expect(memories).toHaveLength(1);
    expect(memories[0]!.importance).toBeGreaterThanOrEqual(0.8);
    expect(memories[0]!.sources.length).toBe(2);
  });

  it('merges semantically identical memories when embeddings are available', async () => {
    h = await createHarness({ embedding: 'ok', embeddingDim: 16 });
    const memory = h.app.services.memory;
    await memory.remember([{ kind: 'profile', content: '用户住在杭州', importance: 0.7, confidence: 0.8 }], 'msg_a');
    // Same characters, different order of punctuation -> identical hashed vector.
    await memory.remember([{ kind: 'profile', content: '用户住在杭州。', importance: 0.7, confidence: 0.8 }], 'msg_b');
    expect(h.app.repos.memories.count()).toBe(1);
  });

  it('recalled memories are injected into the model context', async () => {
    h = await createHarness({
      chat: { script: [['好的'], [EXTRACT([{ kind: 'profile', content: '用户养了一只叫布丁的猫', importance: 0.9, confidence: 0.9 }])], ['当然记得']] }
    });
    await sendText(h.app, '我养了一只猫叫布丁', 'k1');
    await h.app.services.worker.drain();
    expect(h.app.repos.memories.count()).toBe(1);
    await sendText(h.app, '还记得我的猫吗', 'k2');
    const lastCall = h.state.chatCalls.at(-1)!.body as any;
    const system = lastCall.messages[0].content as string;
    expect(system).toContain('布丁');
  });

  it('supports expiry and manual deletion', async () => {
    h = await createHarness();
    const past = new Date(Date.now() - 1000).toISOString();
    h.app.repos.memories.upsert({ kind: 'event', content: '临时事件', expiresAt: past });
    expect(h.app.repos.memories.count()).toBe(1);
    expect(h.app.repos.memories.purgeExpired()).toBe(1);
    expect(h.app.repos.memories.count()).toBe(0);

    const { record } = h.app.repos.memories.upsert({ kind: 'profile', content: '要删除的记忆' });
    expect(h.app.repos.memories.delete(record.id)).toBe(true);
    expect(h.app.repos.memories.count()).toBe(0);
  });
});

describe('embedding degradation', () => {
  it('falls back to FTS with an explicit reason when embeddings are unavailable', async () => {
    h = await createHarness({ embedding: 'off' });
    h.app.repos.memories.upsert({ kind: 'profile', content: '用户在准备一场马拉松比赛' });
    const recall = await h.app.services.memory.recall('马拉松', 5);
    expect(recall.strategy).toBe('fts');
    expect(recall.fallbackReason).toContain('not configured');
    expect(recall.memories.length).toBe(1);
  });

  it('falls back when the embedding provider errors', async () => {
    h = await createHarness({ embedding: 'fail' });
    h.app.repos.memories.upsert({ kind: 'profile', content: '用户喜欢爬山' });
    const recall = await h.app.services.memory.recall('爬山', 5);
    expect(recall.strategy).toBe('fts');
    expect(recall.fallbackReason).toMatch(/failed|status/);
  });

  it('never reports 100% coverage with zero memories', async () => {
    h = await createHarness({ embedding: 'ok' });
    const stats = h.app.services.memory.stats();
    expect(stats.total).toBe(0);
    expect(stats.coverage).toBe(0);
    const recall = await h.app.services.memory.recall('anything');
    expect(recall.embeddingCoverage).toEqual({ withEmbedding: 0, total: 0, ratio: 0 });
    expect(recall.strategy).toBe('none');
  });

  it('reports partial coverage honestly', async () => {
    h = await createHarness({ embedding: 'ok', embeddingDim: 8 });
    await h.app.services.memory.remember([{ kind: 'profile', content: '有向量的记忆', importance: 0.5, confidence: 0.5 }], 'm1');
    h.app.repos.memories.upsert({ kind: 'profile', content: '没有向量的记忆' });
    const stats = h.app.services.memory.stats();
    expect(stats.total).toBe(2);
    expect(stats.withEmbedding).toBe(1);
    expect(stats.coverage).toBeCloseTo(0.5);
  });

  it('reads the embedding dimension from configuration, not a hardcoded value', async () => {
    h = await createHarness({ embedding: 'ok', embeddingDim: 24 });
    expect(h.app.services.capabilities.embeddingDimensions()).toBe(24);
    await h.app.services.memory.remember([{ kind: 'profile', content: '维度测试', importance: 0.5, confidence: 0.5 }], 'm1');
    const row = h.app.repos.memories.rowById(h.app.repos.memories.list({})[0]!.id)!;
    expect(row.embedding_dim).toBe(24);

    await h.cleanup();
    h = await createHarness({ embedding: 'ok', embeddingDim: 64 });
    expect(h.app.services.capabilities.embeddingDimensions()).toBe(64);
  });

  it('backfills embeddings for memories stored while the embedder was down', async () => {
    h = await createHarness({ embedding: 'ok' });
    h.app.repos.memories.upsert({ kind: 'profile', content: '待补向量' });
    expect(h.app.repos.memories.countWithEmbeddings()).toBe(0);
    const done = await h.app.services.memory.backfillEmbeddings();
    expect(done).toBe(1);
    expect(h.app.repos.memories.countWithEmbeddings()).toBe(1);
  });
});

describe('clearing memory', () => {
  it('wipes memories, sources, summaries and the recall index', async () => {
    h = await createHarness({ embedding: 'ok', env: { ADMIN_API_TOKEN: 'admin-secret-token' } });
    await h.app.services.memory.remember(
      [
        { kind: 'profile', content: '用户的秘密信息 alpha', importance: 0.9, confidence: 0.9 },
        { kind: 'project', content: '用户在做 beta 项目', importance: 0.8, confidence: 0.8 }
      ],
      'msg_x'
    );
    h.app.repos.summaries.create({ fromSeq: 1, toSeq: 5, content: '摘要里也有 alpha' });
    expect(h.app.repos.memories.count()).toBe(2);

    const res = await h.app.server.inject({
      method: 'POST',
      url: '/api/admin/memories/clear',
      headers: { 'x-admin-token': 'admin-secret-token' }
    });
    expect(res.statusCode).toBe(200);

    expect(h.app.repos.memories.count(false)).toBe(0);
    expect(h.app.repos.summaries.count()).toBe(0);
    expect(h.app.repos.memories.searchFts('alpha', 10)).toHaveLength(0);
    const sources = h.app.db.prepare('SELECT COUNT(*) c FROM memory_sources').get() as { c: number };
    expect(sources.c).toBe(0);

    // Cleared content must not come back into the model context.
    const recall = await h.app.services.memory.recall('alpha');
    expect(recall.memories).toHaveLength(0);
    h.setChatScript([['好的']]);
    await sendText(h.app, '还记得 alpha 吗', 'after-clear');
    const system = (h.state.chatCalls.at(-1)!.body as any).messages[0].content as string;
    expect(system).not.toContain('alpha');
    expect(system).not.toContain('beta');
  });
});

describe('context compression', () => {
  it('summarizes old messages once and keeps the originals', async () => {
    h = await createHarness({
      env: { SUMMARY_TRIGGER_MESSAGES: '4', SUMMARY_CHUNK_MESSAGES: '4', CONTEXT_RECENT_MESSAGES: '4' },
      chat: { script: [['好的']] }
    });
    for (let i = 0; i < 8; i++) await sendText(h.app, `历史消息 ${i}`, `h${i}`);
    expect(h.app.services.summarizer.needsSummary()).toBe(true);

    h.setChatScript([['这是第一段摘要']]);
    const first = await h.app.services.summarizer.runOnce();
    expect(first.created).toBe(true);
    const covered = h.app.repos.summaries.coveredUpTo();
    expect(covered).toBe(first.toSeq);

    // Same range must never be summarized twice.
    h.setChatScript([['第二段摘要']]);
    const second = await h.app.services.summarizer.runOnce();
    if (second.created) expect(second.fromSeq!).toBeGreaterThan(first.toSeq!);

    // Originals are still in the database.
    expect(h.app.repos.messages.count()).toBe(16);
    const summaries = h.app.repos.summaries.all();
    expect(summaries[0]!.version).toBe(1);
    expect(summaries[0]!.from_seq).toBeLessThanOrEqual(summaries[0]!.to_seq);
  });

  it('injects summaries into the system prompt', async () => {
    h = await createHarness({ chat: { script: [['好的']] } });
    h.app.repos.summaries.create({ fromSeq: 1, toSeq: 10, content: '他们讨论过一次旅行计划' });
    await sendText(h.app, '继续聊', 'ctx1');
    const system = (h.state.chatCalls.at(-1)!.body as any).messages[0].content as string;
    expect(system).toContain('旅行计划');
  });

  it('a summary failure does not break the chat', async () => {
    h = await createHarness({
      env: { SUMMARY_TRIGGER_MESSAGES: '2', SUMMARY_CHUNK_MESSAGES: '2', CONTEXT_RECENT_MESSAGES: '2' },
      chat: { script: [['好的']] }
    });
    for (let i = 0; i < 6; i++) await sendText(h.app, `消息 ${i}`, `f${i}`);
    h.setChatError(new Error('summary model down'));
    const outcome = await h.app.services.summarizer.runOnce();
    expect(outcome.created).toBe(false);
    h.setChatError(null);
    h.setChatScript([['依然可以聊天']]);
    const { body } = await sendText(h.app, '还在吗', 'after-fail');
    expect(body.reply.content[0].text).toBe('依然可以聊天');
  });

  it('does not send the entire history to the model', async () => {
    h = await createHarness({ env: { CONTEXT_RECENT_MESSAGES: '6' }, chat: { script: [['好的']] } });
    for (let i = 0; i < 15; i++) await sendText(h.app, `长历史 ${i}`, `l${i}`);
    const lastCall = h.state.chatCalls.at(-1)!.body as any;
    // 1 system + at most 6 recent turns.
    expect(lastCall.messages.length).toBeLessThanOrEqual(7);
    expect(h.app.repos.messages.count()).toBe(30);
  });
});
