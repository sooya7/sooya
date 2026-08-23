import type { ChatProvider } from '../../providers/types.js';
import type { ErrorLogRepo } from '../../db/repos/misc.repo.js';
import type { AnalyzerInput, AnalyzerOutput } from './types.js';
import { parseAnalyzerOutput } from './schema.js';

const EMPTY: AnalyzerOutput = {
  commitments: [],
  commitment_resolutions: [],
  relationship_signals: [],
  relationship_resolutions: []
};

function buildSystemPrompt(input: AnalyzerInput, relationshipEnabled: boolean): string {
  const active = input.activeCommitments.length
    ? input.activeCommitments
        .map(
          (c) =>
            `- id=${c.id} [${c.kind}/${c.subject}] ${c.title}（状态 ${c.status}${c.dueLocalDate ? `，时间 ${c.dueLocalDate}` : '，未定时'}）`
        )
        .join('\n')
    : '（当前没有未完成事项）';

  const threads = input.activeThreads.length
    ? input.activeThreads.map((t) => `- id=${t.id} [${t.kind}] ${t.title}（${t.status}）`).join('\n')
    : '（当前没有延续中的关系话题）';

  const lines = [
    '你是 SOOYA 的语义分析器，在每轮对话结束后运行。分析下面这轮对话，输出结构化 JSON。',
    '',
    '## 输入',
    `当前本地时间：${input.timeZone} ${zonedNow(input)}`,
    `未完成事项列表（resolution 只能引用这里的 id）：`,
    active,
    '',
    '## 抽取新事项 commitments',
    '- 只抽取明确指向未来的事项：用户的事件/安排、双方约定、用户要求的提醒、待跟进事项。',
    '- 用户自己说的事 subject=user；你自己答应的事（“我晚点提醒你”“我之后再问你”）subject=assistant。',
    '- 只有带明确可解析日期/时段的自身时间承诺才用 kind=assistant_commitment；没有具体时间、依赖用户后续动作的承诺（如“你发结果我再看”）用 kind=follow_up 且 subject=assistant。',
    '- title 用 2~8 个字的名词短语，不要包含日期本身（“考试”“挑电影”“续费服务器”）。',
    '- date_text 原样引用用户的时间说法（“周五”“下个月15号”“今晚”），绝不换算成具体日期。',
    '- time_text 只在有明确钟点时给出，保留时段词（“晚上八点半”）。',
    '- 只是模糊的可能性（“下个月可能去大阪”）confidence 低于 0.55。',
    '- 用户明确说“明天提醒我”的 kind=reminder_request 且 follow_up=explicit_reminder。',
    '',
    '## 解析既有事项 commitment_resolutions',
    '- 用户确认完成（“考完了”“已经合了”）→ action=completed。',
    '- 用户取消（“不去了”“算了”）→ action=cancelled。',
    '- 用户改期（“改到下周”“推迟到周五”）→ action=rescheduled 并在 date_text 给出新时间说法。',
    '- 你在本轮回复里实际兑现了自己之前的承诺（真的提醒了/真的帮用户看了）→ 对应 assistant commitment action=completed。',
    '- 判定依据是本轮回复的实际行为，不能仅因为话题相关就标 completed。',
    '- 只是再次承诺但还没做 → 不要输出 resolution。',
    '- resolution 的 commitment_id 必须来自上面的未完成事项列表，不许编造。',
    '',
    '没有可输出的就全部返回空数组。只输出 JSON，不要解释。'
  ];

  if (relationshipEnabled) {
    lines.push(
      '',
      '## 关系延续信号 relationship_signals',
      '- 连续出现的共同话题、未解决的分歧、共同经历、持续玩笑、关心语境。',
      '- 不抽取稳定偏好（那属于记忆）也不抽取带明确时间的事项（那属于 commitments）。',
      '',
      '## 关系收尾 relationship_resolutions',
      '- 明确收尾的话题/和解的分歧 → action=completed；放弃的 → cancelled；有进展 → updated。',
      `- thread_id 必须来自下面的 open threads 列表，不许编造：`,
      threads
    );
  }

  return lines.join('\n');
}

function zonedNow(input: AnalyzerInput): string {
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: input.timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  return dtf.format(input.now);
}

/**
 * One structured LLM call after the final reply is published (§7).
 *
 * A valid empty JSON payload is a successful "nothing to extract" result.
 * Provider failures and malformed JSON are different: they throw so the
 * durable future.analyze job can retry instead of permanently consuming the
 * extraction fence with a false empty result.
 */
export class PostTurnSemanticAnalyzer {
  constructor(
    private readonly deps: {
      provider: ChatProvider;
      relationshipEnabled: boolean;
      errors?: ErrorLogRepo;
    }
  ) {}

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    if (!input.userText.trim() && !input.assistantText.trim()) return EMPTY;
    if (!this.deps.provider.configured) {
      const error = new Error('post_turn_analyzer_unconfigured');
      this.deps.errors?.add('post_turn.analyzer', error.message);
      throw error;
    }

    try {
      const result = await this.deps.provider.complete({
        system: buildSystemPrompt(input, this.deps.relationshipEnabled),
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: `用户说：${input.userText || '(无)'}\n\n你回复：${input.assistantText || '(无)'}` }]
          }
        ],
        maxTokens: 700,
        temperature: 0,
        jsonMode: true
      });
      const parsed = parseAnalyzerOutput(result.text);
      if (!parsed) {
        const error = new Error('post_turn_analyzer_unparseable_output');
        this.deps.errors?.add('post_turn.analyzer', 'unparseable_output', { model: result.model, sample: result.text.slice(0, 200) });
        throw error;
      }
      return {
        commitments: parsed.commitments,
        commitment_resolutions: parsed.commitment_resolutions,
        // Relationship fields are only requested (and only consumed) when the
        // flag is on; otherwise the schema's empty defaults apply.
        relationship_signals: this.deps.relationshipEnabled ? parsed.relationship_signals : [],
        relationship_resolutions: this.deps.relationshipEnabled ? parsed.relationship_resolutions : []
      };
    } catch (err) {
      const error = err as Error;
      if (error.message !== 'post_turn_analyzer_unparseable_output') {
        this.deps.errors?.add('post_turn.analyzer', error.message);
      }
      throw error;
    }
  }
}
