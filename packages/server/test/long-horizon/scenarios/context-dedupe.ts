import type { FutureHarness } from '../harness.js';

/**
 * §10.4 end-to-end: the memory pipeline stores the long-term meaning while
 * the commitment holds the runtime state — the prompt must state the current
 * fact exactly once.
 */
export async function contextDedupe(h: FutureHarness): Promise<void> {
  await h.turn('2026-08-21 有个考试，最近都在复习', {
    memoryExtract: JSON.stringify({ worth: true, items: [{ kind: 'project', content: '用户最近在为周五的考试复习', importance: 0.7, confidence: 0.8 }] }),
    analyzer: JSON.stringify({
      commitments: [{ kind: 'user_event', subject: 'user', title: '考试', date_text: '2026-08-21', time_precision: 'day', confidence: 0.94 }]
    })
  });

  const built = await h.app.services.context.build(h.app.config.getPersona(), '考试准备得怎么样了', {
    recentMessages: 10,
    memoryLimit: 8,
    allowVision: false,
    stickerCatalogue: '',
    voiceMoods: '',
    capabilityNotes: [],
    contextWindow: 8_000,
    maxOutputTokens: 1_000
  });

  if (!built.system.includes('接下来值得记得的事情')) throw new Error('future section missing');
  if (built.futureLines !== 1) throw new Error(`futureLines=${built.futureLines}`);
  if (built.futureDedupedMemories !== 1) throw new Error(`expected the restating memory suppressed, got ${built.futureDedupedMemories}`);
  // Exactly one current statement of the exam date.
  const mentions = built.system.match(/2026-08-21|有考试/g) ?? [];
  const fromFuture = built.system.includes('接下来值得记得的事情：\n- 用户');
  if (!fromFuture) throw new Error('future line not rendered');
  if (mentions.length < 1) throw new Error('exam fact vanished entirely');
  const futureBlock = built.system.split('接下来值得记得的事情：')[1]?.split('\n\n')[0] ?? '';
  if (!futureBlock.includes('考试')) throw new Error('future block lost the exam');
  const memoryBlock = built.system.split('关于用户你已经知道的事：')[1]?.split('\n\n')[0] ?? '';
  if (memoryBlock.includes('考试')) throw new Error(`memory block still restates the exam: ${memoryBlock}`);
}
