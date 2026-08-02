import { afterEach, describe, expect, it } from 'vitest';
import { parseCandidates } from '../src/core/memory.js';
import { createHarness, sendText, type Harness } from './helpers/harness.js';

const ADMIN = { 'x-admin-token': 'admin-memory-token' };
const EXTRACT = (items: unknown) => JSON.stringify({ worth: true, items });
let h: Harness | null = null;

afterEach(async () => {
  if (h) await h.cleanup();
  h = null;
});

describe('narrow memory ownership', () => {
  it('skips emoji-only and low-information text without calling the extractor model', async () => {
    h = await createHarness({ chat: { script: [[EXTRACT([{ kind: 'event', content: '不应调用' }])]] } });

    expect(await h.app.services.memory.extractCandidates('😂😂😂😂', '')).toEqual([]);
    expect(await h.app.services.memory.extractCandidates('好', '')).toEqual([]);
    expect(h.state.chatCalls).toHaveLength(0);
  });

  it('drops temporary life and software-capability claims returned by the model', async () => {
    h = await createHarness({
      chat: {
        script: [[EXTRACT([
          { kind: 'event', content: '用户刚吃完饭', importance: 0.4, confidence: 0.8 },
          { kind: 'event', content: '助手现在在散步', importance: 0.4, confidence: 0.8 },
          { kind: 'event', content: '图片功能暂时不可用', importance: 0.4, confidence: 0.8 },
          { kind: 'preference', content: '用户不吃香菜', importance: 0.8, confidence: 0.9 }
        ])]]
      }
    });

    const candidates = await h.app.services.memory.extractCandidates('我刚吃完饭，不过我一直不吃香菜', '我正在散步；图片功能暂时不可用');
    expect(candidates.map((candidate) => candidate.content)).toEqual(['用户不吃香菜']);
  });

  it('rejects summary as a normal memory and gives events a bounded default lifetime', () => {
    const before = Date.now();
    const parsed = parseCandidates(EXTRACT([
      { kind: 'summary', content: '阶段摘要的重复拷贝' },
      { kind: 'event', content: '用户获得了比赛资格' }
    ]));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.kind).toBe('event');
    const days = (Date.parse(parsed[0]!.expiresAt!) - before) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(59.9);
    expect(days).toBeLessThanOrEqual(60.1);
  });

  it('supersedes a conflicting stable fact instead of injecting both', async () => {
    h = await createHarness({ embedding: 'off' });
    const old = (await h.app.services.memory.remember([
      { kind: 'preference', content: '用户喜欢喝咖啡', importance: 0.8, confidence: 0.9 }
    ], 'source-old'));
    expect(old.stored).toBe(1);

    const changed = await h.app.services.memory.remember([
      { kind: 'preference', content: '用户不再喝咖啡', importance: 0.9, confidence: 0.95 }
    ], 'source-new');
    expect(changed).toMatchObject({ stored: 1, superseded: 1 });

    const all = h.app.repos.memories.list({ includeInactive: true });
    const current = all.find((memory) => memory.content === '用户不再喝咖啡')!;
    const previous = all.find((memory) => memory.content === '用户喜欢喝咖啡')!;
    expect(h.app.repos.memories.list()).toEqual([current]);
    expect(previous.supersededById).toBe(current.id);
    expect(current.supersedesId).toBe(previous.id);
    expect(current.sources).toEqual(['source-new']);
  });

  it('runs extraction once for one rapid-message batch', async () => {
    h = await createHarness({
      chat: {
        delayMs: 20,
        script: [
          ['收到'],
          [EXTRACT([{ kind: 'project', content: '用户正在规划一次长途旅行', importance: 0.7, confidence: 0.8 }])]
        ]
      }
    });

    await Promise.all([
      sendText(h.app, '我准备', 'memory-batch-1'),
      sendText(h.app, '今年秋天', 'memory-batch-2'),
      sendText(h.app, '规划一次长途旅行', 'memory-batch-3')
    ]);
    await h.app.services.worker.drain();

    const jobs = h.app.repos.jobs.list(100).filter((job) => job.type === 'memory.extract');
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]!.payload_json).userMessageIds).toHaveLength(3);
    expect(h.app.repos.memories.list()).toHaveLength(1);
  });
});

describe('memory context dedupe and observability', () => {
  const options = {
    recentMessages: 10,
    memoryLimit: 8,
    allowVision: false,
    stickerCatalogue: '',
    voiceMoods: '',
    capabilityNotes: [],
    contextWindow: 8_000,
    maxOutputTokens: 1_000
  };

  it('deduplicates persona, summary, memory and recent-message facts before injection', async () => {
    h = await createHarness({ embedding: 'off' });
    const memory = h.app.repos.memories.upsert({
      kind: 'preference', content: '用户喜欢手冲咖啡', sourceMessageId: 'memory-source'
    }).record;
    h.app.repos.summaries.create({ fromSeq: 1, toSeq: 2, content: '用户喜欢手冲咖啡' });
    h.app.repos.messages.create({ role: 'user', status: 'sent', parts: [{ type: 'text', text: '我喜欢手冲咖啡' }] });
    const persona = { ...h.app.config.getPersona(), relationshipContext: '用户喜欢手冲咖啡' };

    const built = await h.app.services.context.build(persona, '手冲咖啡', options);
    expect(built.system.match(/用户喜欢手冲咖啡/g)).toHaveLength(1);
    expect(built.memoryTrace.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: memory.id, included: false, droppedReason: 'deduplicated_persona', sources: ['memory-source'] })
    ]));
    expect(built.memoryTrace.stats.deduplicated).toBeGreaterThanOrEqual(1);
  });

  it('exposes the last recall strategy, reasons, sources and budget/dedupe statistics only to admin', async () => {
    h = await createHarness({
      embedding: 'off',
      env: { ADMIN_API_TOKEN: 'admin-memory-token' }
    });
    h.app.repos.memories.upsert({ kind: 'project', content: '用户正在制作月球灯', sourceMessageId: 'source-message' });
    await h.app.services.context.build(h.app.config.getPersona(), '月球灯', options);

    const unauthorized = await h.app.server.inject({ method: 'GET', url: '/api/admin/memories' });
    expect(unauthorized.statusCode).toBe(401);
    const response = await h.app.server.inject({ method: 'GET', url: '/api/admin/memories', headers: ADMIN });
    expect(response.statusCode).toBe(200);
    const trace = response.json().recall;
    expect(trace).toMatchObject({ strategy: 'fts', stats: { recalled: 1 } });
    expect(trace.entries[0]).toMatchObject({
      content: '用户正在制作月球灯',
      reason: expect.stringContaining('FTS'),
      sources: ['source-message']
    });
    expect(trace.stats).toEqual(expect.objectContaining({ included: expect.any(Number), budgetDropped: expect.any(Number), deduplicated: expect.any(Number) }));
  });
});
