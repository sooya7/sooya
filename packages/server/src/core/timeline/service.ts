import type { EpisodeRepo, EpisodeKind } from '../../db/repos/episode.repo.js';
import type { MessageRepo } from '../../db/repos/message.repo.js';
import type { ChatMessage } from '../types.js';
import type { CommitmentRepo } from '../../db/repos/commitment.repo.js';
import type { RelationshipThreadRepo } from '../../db/repos/relationship-thread.repo.js';
import type { MomentRepo } from '../../db/repos/moment.repo.js';
import type { SettingsRepo } from '../../db/repos/misc.repo.js';
import type { ChatProvider } from '../../providers/types.js';
import { ngrams } from '../../db/repos/memory.repo.js';
import { isoToZonedDate } from '../future/time-parser.js';

const CLOSE_GAP_MS = 3 * 3_600_000;
const LAST_SWEEP_KEY = 'timeline.lastSweptMessageId';

export interface SweepOutcome {
  closed: number;
  opened: number;
  attached: number;
  milestones: number;
}

/**
 * Shared Timeline (§21/§22): builds Episodes as an index of references —
 * time window + topic boundary + day cut — as a background sweep off the
 * reply path. Significant events become milestone episodes immediately.
 */
export class TimelineService {
  constructor(
    private readonly deps: {
      repo: EpisodeRepo;
      messages: MessageRepo;
      commitments: CommitmentRepo;
      threads: RelationshipThreadRepo;
      moments: MomentRepo;
      settings: SettingsRepo;
      summaryProvider?: ChatProvider;
      timeZone: string;
      enabled: boolean;
      clock?: () => Date;
    }
  ) {}

  async sweep(now: Date = this.deps.clock?.() ?? new Date()): Promise<SweepOutcome> {
    if (!this.deps.enabled) return { closed: 0, opened: 0, attached: 0, milestones: 0 };
    const outcome: SweepOutcome = { closed: 0, opened: 0, attached: 0, milestones: 0 };
    const awaitable: Array<Promise<void>> = [];

    // 1. Close stale open episodes: 3h silence or local day cut (§22).
    for (const open of this.deps.repo.openRows()) {
      const last = this.deps.repo.lastMessageAt(open.id) ?? open.ended_at;
      const dayCut = isoToZonedDate(last, this.deps.timeZone) !== isoToZonedDate(now.toISOString(), this.deps.timeZone);
      const gap = now.getTime() - Date.parse(last) >= CLOSE_GAP_MS;
      if (dayCut || gap) {
        awaitable.push(this.closeEpisode(open.id, now));
        outcome.closed++;
      }
    }

    // 2. Fold new messages into the (still) open episode, opening new ones on
    //    topic switch, day cut or gap.
    const recent = this.deps.messages.recent(40);
    const lastSwept = this.deps.settings.get<string>(LAST_SWEEP_KEY, '');
    const lastIdx = lastSwept ? recent.findIndex((m) => m.id === lastSwept) : -1;
    const window = (lastIdx >= 0 ? recent.slice(lastIdx + 1) : recent.slice(-10)).filter((m) => m.role !== 'system');
    let current = this.deps.repo.open();
    let currentText = current ? this.recentEpisodeText(current.id) : '';
    for (const message of window) {
      const created = message.createdAt;
      const localDate = isoToZonedDate(created, this.deps.timeZone);
      const text = plainText(message);
      if (!text) continue;
      const needsNew =
        !current ||
        isoToZonedDate(this.deps.repo.lastMessageAt(current.id) ?? current.ended_at, this.deps.timeZone) !== localDate ||
        this.topicsDiverged(currentText, text);
      if (needsNew) {
        if (current) {
          this.deps.repo.close(current.id, { title: this.heuristicTitle(currentText), summary: '', endedAt: created });
          outcome.closed++;
        }
        current = this.deps.repo.create({ kind: 'conversation', startedAt: created, localDate });
        currentText = '';
        outcome.opened++;
      }
      const episode = current!;
      this.deps.repo.attachMessage(episode.id, message.id);
      this.deps.repo.extend(episode.id, created);
      currentText = `${currentText}\n${text}`.slice(-2000);
      outcome.attached++;
    }
    if (window.length > 0) this.deps.settings.set(LAST_SWEEP_KEY, window[window.length - 1]!.id);

    // 3. Attach same-day commitments/threads/moments to the matching episode.
    this.attachContextualRefs(now, outcome);

    // 4. Milestones: important commitments completed since the last sweep
    //    become their own episode immediately (§22 重大事件).
    const doneToday = this.deps.commitments.list({ status: 'completed', includeArchived: true, limit: 20 }).filter(
      (c) => c.completedAt && isoToZonedDate(c.completedAt, this.deps.timeZone) === isoToZonedDate(now.toISOString(), this.deps.timeZone) && c.importance >= 0.7
    );
    for (const c of doneToday) {
      if (this.deps.repo.listByDateRange(isoToZonedDate(now.toISOString(), this.deps.timeZone), isoToZonedDate(now.toISOString(), this.deps.timeZone)).some((e) => e.kind === 'milestone' && e.commitmentIds.includes(c.id))) continue;
      const episode = this.deps.repo.create({ kind: 'milestone', startedAt: c.completedAt!, localDate: isoToZonedDate(c.completedAt!, this.deps.timeZone), title: c.title, salience: 0.9 });
      this.deps.repo.attachCommitment(episode.id, c.id);
      this.deps.repo.close(episode.id, { title: `完成了：${c.title}`, summary: c.outcome ?? '' });
      outcome.milestones++;
    }

    // Close summaries are model-written when a provider is configured; each
    // close is independent but the sweep awaits them so callers observe a
    // settled timeline (the maintenance job is already async).
    await Promise.allSettled(awaitable);
    return outcome;
  }

  private attachContextualRefs(now: Date, outcome: SweepOutcome): void {
    const today = isoToZonedDate(now.toISOString(), this.deps.timeZone);
    const episodes = this.deps.repo.listByDateRange(today, today);
    for (const c of this.deps.commitments.list({ limit: 50 })) {
      if (!c.dueAt) continue;
      const day = isoToZonedDate(c.dueAt, this.deps.timeZone);
      const episode = episodes.find((e) => e.localDate === day && e.kind !== 'milestone');
      if (episode && !episode.commitmentIds.includes(c.id)) {
        this.deps.repo.attachCommitment(episode.id, c.id);
        outcome.attached++;
      }
    }
    for (const t of this.deps.threads.list({ limit: 50 })) {
      const day = isoToZonedDate(t.lastTouchedAt, this.deps.timeZone);
      const episode = episodes.find((e) => e.localDate === day && e.kind !== 'milestone');
      if (episode && !episode.relationshipThreadIds.includes(t.id)) {
        this.deps.repo.attachThread(episode.id, t.id);
        outcome.attached++;
      }
    }
    for (const moment of this.deps.moments.list(20)) {
      const day = isoToZonedDate(moment.created_at, this.deps.timeZone);
      const episode = episodes.find((e) => e.localDate === day && e.kind !== 'milestone');
      if (episode && !episode.momentIds.includes(moment.id)) {
        this.deps.repo.attachMoment(episode.id, moment.id);
        outcome.attached++;
      }
    }
  }

  /** §22 topic boundary: shared-bigram collapse means a new topic. */
  private topicsDiverged(currentText: string, incoming: string): boolean {
    if (!currentText.trim()) return false;
    const ga = ngrams(currentText, 2);
    const gb = ngrams(incoming, 2);
    if (ga.size === 0 || gb.size === 0) return false;
    let shared = 0;
    for (const g of gb) if (ga.has(g)) shared++;
    return shared / gb.size < 0.08;
  }

  private heuristicTitle(text: string): string {
    const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    return first.slice(0, 24) || '一段日常';
  }

  private recentEpisodeText(episodeId: string): string {
    return this.deps.repo
      .messageIds(episodeId)
      .map((id) => this.deps.messages.get(id))
      .filter((m): m is ChatMessage => Boolean(m))
      .map(plainText)
      .filter(Boolean)
      .join('\n')
      .slice(-2000);
  }

  /** Model-written close summary; heuristic title fallback stays usable. */
  private async closeEpisode(episodeId: string, now: Date): Promise<void> {
    const text = this.recentEpisodeText(episodeId).slice(-1500);
    const fallbackTitle = this.heuristicTitle(text);
    const provider = this.deps.summaryProvider;
    if (!provider?.configured || !text) {
      this.deps.repo.close(episodeId, { title: fallbackTitle, summary: text.slice(0, 200), endedAt: now.toISOString() });
      return;
    }
    try {
      const result = await provider.complete({
        system: '给一段两个人的聊天记录起标题和一句话摘要。只输出 JSON：{"title":"8字以内","summary":"40字以内"}',
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        maxTokens: 120,
        temperature: 0.3,
        jsonMode: true
      });
      const parsed = JSON.parse(result.text.slice(result.text.indexOf('{'), result.text.lastIndexOf('}') + 1)) as { title?: string; summary?: string };
      this.deps.repo.close(episodeId, {
        title: (parsed.title ?? fallbackTitle).slice(0, 24),
        summary: (parsed.summary ?? '').slice(0, 200),
        endedAt: now.toISOString()
      });
    } catch {
      this.deps.repo.close(episodeId, { title: fallbackTitle, summary: text.slice(0, 200), endedAt: now.toISOString() });
    }
  }
}

function plainText(message: ChatMessage): string {
  return message.content
    .map((p: ChatMessage['content'][number]) => (p.type === 'text' ? p.text ?? '' : ''))
    .filter(Boolean)
    .join(' ');
}
