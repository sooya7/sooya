import type { CommitmentRepo } from '../../db/repos/commitment.repo.js';
import type { Commitment } from './types.js';
import { isoToZonedDate, zonedParts } from './time-parser.js';

const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * Future Context (§9): the few lines about open commitments that enter the
 * system prompt. Lives after memory and before life state (§11), hard-capped
 * at 5 lines — the whole point is salience, not completeness.
 */
export class FutureContextService {
  constructor(
    private readonly deps: {
      repo: CommitmentRepo;
      timeZone: string;
      clock?: () => Date;
    }
  ) {}

  contextLines(now: Date = this.deps.clock?.() ?? new Date()): string[] {
    return this.deps.repo
      .upcoming(5)
      .map((c) => this.renderLine(c, now))
      .filter((line): line is string => line !== null);
  }

  private renderLine(c: Commitment, now: Date): string | null {
    switch (c.kind) {
      case 'reminder_request':
        return `- 用户让你提醒：${c.title}${this.clockSuffix(c, now)}。`;
      case 'follow_up':
        return `- ${c.subject === 'assistant' ? '你答应过' : c.subject === 'shared' ? '你们' : '用户'}要跟进「${c.title}」，尚未确认完成。`;
      case 'assistant_commitment':
        return `- 你答应过用户：${c.title}${this.clockSuffix(c, now)}。`;
      case 'shared_plan':
        return `- 你们说好${this.dayPhrase(c, now) || '有空时'}一起${c.title}。`;
      default: {
        const maybe = c.status === 'tentative' ? '可能' : '';
        if (!c.dueAt) return `- 用户${maybe}${c.title}（时间未定）。`;
        const days = this.daysUntil(c, now);
        if (days <= 0) return `- 用户${maybe}今天有${c.title}。`;
        if (days === 1) return `- 用户${maybe}明天有${c.title}。`;
        return `- 用户${maybe}${this.weekdayLabel(c)}有${c.title}，还有 ${days} 天。`;
      }
    }
  }

  /** Clock phrase for exact items ("明天 09:00"); empty for day-level items. */
  private clockSuffix(c: Commitment, now: Date): string {
    if (c.timePrecision !== 'exact' || !c.startsAt) return '';
    const at = zonedParts(new Date(c.startsAt), this.deps.timeZone);
    const clock = `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;
    const days = c.dueAt ? this.daysUntil(c, now) : null;
    const day = days === null ? '' : days <= 0 ? '今天' : days === 1 ? '明天' : this.weekdayLabel(c);
    return `（${day} ${clock}）`;
  }

  /** Day phrase for shared plans ("今晚"-style reads better bare); empty when undated. */
  private dayPhrase(c: Commitment, now: Date): string {
    if (!c.dueAt) return '';
    const days = this.daysUntil(c, now);
    if (days <= 0) return '今天';
    if (days === 1) return '明天';
    if (days === 2) return '后天';
    return `${this.weekdayLabel(c)}（还有 ${days} 天）`;
  }

  private daysUntil(c: Commitment, now: Date): number {
    if (!c.dueAt) return Number.NaN;
    const dueDate = isoToZonedDate(c.dueAt, this.deps.timeZone);
    const today = isoToZonedDate(now.toISOString(), this.deps.timeZone);
    return Math.round((Date.parse(`${dueDate}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  }

  private weekdayLabel(c: Commitment): string {
    if (!c.dueAt) return '';
    return WEEKDAY_LABELS[zonedParts(new Date(c.dueAt), this.deps.timeZone).weekday] ?? '';
  }
}
