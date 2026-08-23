import type { FutureHarness } from '../harness.js';

/**
 * §28 Relationship scenario: an unresolved thread opens, gets explicitly
 * resolved, and — ten days later — must not leak back into context
 * (resolved_thread_leak_rate).
 */
export async function relationshipResolution(h: FutureHarness): Promise<void> {
  const repo = h.app.repos.relationshipThreads;
  const relationship = h.app.services.relationship;

  // Day 1: a disagreement surfaces and stays half-finished.
  await h.turn('昨天那件事我还是有点难受', {
    analyzer: JSON.stringify({
      commitments: [],
      relationship_signals: [{ kind: 'unresolved_issue', title: '昨晚的误会', summary: '解释过但情绪还没完全过去', confidence: 0.85 }]
    })
  });
  const thread = repo.list({ status: 'open' })[0];
  if (!thread) throw new Error('expected an open unresolved thread');
  if (!h.app.services.relationshipContext.contextLines().some((line) => line.includes('昨晚的误会'))) {
    throw new Error('open thread missing from relationship context');
  }

  // Day 2: explicit reconciliation.
  h.setNow('2026-08-20T02:00:00.000Z');
  await h.turn('没事了，说开就好了', {
    analyzer: JSON.stringify({
      commitments: [],
      relationship_resolutions: [{ thread_id: thread.id, action: 'completed', confidence: 0.95 }]
    })
  });
  if (repo.get(thread.id)!.status !== 'resolved') throw new Error('thread should be resolved');

  // Day 10: nothing about the fight may resurface as if unresolved.
  h.setNow('2026-08-29T02:00:00.000Z');
  relationship.tick(h.now());
  const lines = h.app.services.relationshipContext.contextLines();
  if (lines.some((line) => line.includes('昨晚的误会'))) throw new Error(`resolved thread leaked: ${lines.join(' | ')}`);
}
