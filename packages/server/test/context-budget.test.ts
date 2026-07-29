import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sendText, type Harness } from './helpers/harness.js';

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = null;
});

describe('context token budget', () => {
  it('keeps high-authority world facts while staying inside a small model window', async () => {
    harness = await createHarness();
    harness.app.repos.messages.create({
      role: 'user',
      status: 'sent',
      parts: [{ type: 'text', text: '请继续预算测试', status: 'sent' }]
    });
    harness.app.repos.world.create({
      kind: 'fact',
      subject: '预算测试-管理员规则',
      predicate: '必须遵守',
      object: `最高优先级-${'甲'.repeat(320)}`,
      confidence: 1,
      authority: 'user'
    });
    for (let index = 0; index < 17; index++) {
      harness.app.repos.world.create({
        kind: 'fact',
        subject: `预算测试-普通事实-${index}`,
        predicate: '描述',
        object: `低优先级-${index}-${'乙'.repeat(320)}`,
        confidence: 0.5,
        authority: 'model'
      });
    }
    const disabled = harness.app.repos.world.create({
      kind: 'fact',
      subject: '预算测试-禁用事实',
      predicate: '不得注入',
      object: '禁用内容',
      confidence: 1,
      authority: 'admin'
    });
    harness.app.repos.world.update(disabled.id, { active: false });

    const built = await harness.app.services.context.build(
      harness.app.config.getPersona(),
      '预算测试',
      {
        recentMessages: 6,
        memoryLimit: 8,
        allowVision: false,
        stickerCatalogue: '',
        capabilityNotes: [],
        contextWindow: 1400,
        maxOutputTokens: 300
      }
    );

    expect(built.inputBudget).toBe(972);
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(built.inputBudget);
    expect(built.worldEntries).toBeGreaterThan(0);
    expect(built.worldEntries).toBeLessThan(18);
    expect(built.droppedWorldEntries).toBeGreaterThan(0);
    expect(built.system).toContain('最高优先级');
    expect(built.system).not.toContain('禁用内容');
    expect(built.turns.at(-1)?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: '请继续预算测试' })])
    );
  });

  it('retains a bounded form of the latest user turn instead of dropping it', async () => {
    harness = await createHarness();
    harness.app.repos.messages.create({
      role: 'user',
      status: 'sent',
      parts: [{ type: 'text', text: `最重要的新请求-${'长'.repeat(3000)}`, status: 'sent' }]
    });

    const built = await harness.app.services.context.build(
      harness.app.config.getPersona(),
      '最重要的新请求',
      {
        recentMessages: 6,
        memoryLimit: 8,
        allowVision: false,
        stickerCatalogue: '',
        capabilityNotes: [],
        contextWindow: 1000,
        maxOutputTokens: 300
      }
    );

    expect(built.estimatedInputTokens).toBeLessThanOrEqual(built.inputBudget);
    expect(built.turns).toHaveLength(1);
    expect(built.turns[0]?.role).toBe('user');
    expect(built.turns[0]?.content[0]).toMatchObject({ type: 'text' });
    expect((built.turns[0]?.content[0] as { text: string }).text).toContain('最重要的新请求');
  });

  it('persists budget usage and dropped counts on the assistant reply', async () => {
    harness = await createHarness({ chat: { script: [['预算记录完成']] } });
    const { body } = await sendText(harness.app, '记录这次上下文预算', 'context-budget-meta');

    expect(body.reply.meta.contextBudget).toMatchObject({
      inputBudget: expect.any(Number),
      estimatedInputTokens: expect.any(Number),
      maxOutputTokens: expect.any(Number),
      droppedSummaries: expect.any(Number),
      droppedMemories: expect.any(Number),
      droppedWorldEntries: expect.any(Number),
      droppedRecentMessages: expect.any(Number)
    });
    expect(body.reply.meta.contextBudget.estimatedInputTokens)
      .toBeLessThanOrEqual(body.reply.meta.contextBudget.inputBudget);
  });
});
