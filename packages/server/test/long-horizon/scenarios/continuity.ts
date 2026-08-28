import type { FutureHarness } from '../harness.js';
import { resolveVisualTime } from '../../../src/core/visual-time.js';

/**
 * §28 Preference Change (fact_consistency): a changed preference becomes the
 * current fact, the old one stays retrievable as history, and the prompt never
 * carries both as current truth.
 */
export async function preferenceChange(h: FutureHarness): Promise<void> {
  const repo = h.app.repos.memories;

  // Day 1: no coffee.
  const old = repo.upsert({ kind: 'preference', content: '用户不喝咖啡', importance: 0.7, confidence: 0.8, sourceMessageId: 'd1' }).record;
  // Day 20: lattes happened — a correction that supersedes the old fact.
  const replacement = repo.supersede(old.id, {
    kind: 'preference',
    content: '用户最近开始喝拿铁',
    importance: 0.7,
    confidence: 0.85,
    sourceMessageId: 'd20'
  }).replacement;

  // Day 60: recall for a breakfast question surfaces the current fact only.
  h.setNow('2026-10-18T02:00:00.000Z');
  const built = await h.app.services.context.build(h.app.config.getPersona(), '早餐喝什么好', {
    recentMessages: 10,
    memoryLimit: 8,
    allowVision: false,
    stickerCatalogue: '',
    voiceMoods: '',
    capabilityNotes: [],
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
    visualTime: resolveVisualTime({ now: '2026-08-26T05:17:23.000Z' })
  });
  if (built.system.includes('用户不喝咖啡')) throw new Error('superseded preference still injected as current');
  // History remains queryable even though it left the prompt.
  if (!repo.get(old.id)) throw new Error('superseded memory row was destroyed instead of kept as history');
  if (repo.get(replacement.id)!.supersedesId !== old.id) throw new Error('supersede chain broken');
}

/**
 * §28 Project Continuity: a finished project must never be spoken of as
 * "still ongoing", and the timeline can still recall it.
 */
export async function projectContinuity(h: FutureHarness): Promise<void> {
  const repo = h.app.repos.commitments;

  await h.turn('等这个 PR 合了再一起看看', {
    analyzer: JSON.stringify({
      commitments: [{ kind: 'follow_up', subject: 'user', title: 'pr 检查', time_precision: 'unknown', confidence: 0.85 }]
    })
  });
  const followUp = repo.list().find((c) => c.title === 'pr 检查');
  if (!followUp) throw new Error('follow_up not extracted');

  // Day 20: merged and done.
  h.setNow('2026-09-08T02:00:00.000Z');
  await h.turn('已经合了，效果不错', {
    analyzer: JSON.stringify({
      commitments: [],
      commitment_resolutions: [{ commitment_id: followUp.id, action: 'completed', outcome: '已合并', confidence: 0.95 }]
    })
  });
  if (repo.get(followUp.id)!.status !== 'completed') throw new Error('follow_up should be completed');

  // Day 30: mentioning it again must not resurrect it as pending context.
  h.setNow('2026-09-18T02:00:00.000Z');
  h.app.services.future.tick(h.now());
  const lines = h.app.services.futureContext.contextLines();
  if (lines.some((line) => line.includes('尚未确认完成'))) throw new Error(`completed project leaked as ongoing: ${lines.join(' | ')}`);
  // But the history row is intact for "还记得吗" recall.
  if (repo.get(followUp.id)!.outcome !== '已合并') throw new Error('history outcome lost');
}
