/**
 * Voice semantic guard (P1-5): the naturalness guard judges how the script
 * SOUNDS; this one checks that the script did not ADD high-risk facts the
 * canonical reply never stated. Numbers, dates/times, amounts, strong
 * negations and explicit promises are the tokens that flip or invent meaning
 * when a rewrite hallucinates them.
 */

export interface SemanticRiskReport {
  ok: boolean;
  risks: string[];
}

const NUMBER_RE = /\d[\d,，.]*\d?|\d+/gu;
const DATE_TIME_RE = /\d{1,4}\s*[年/.-]\s*\d{1,2}\s*[月/.-]\s*\d{1,2}|(?:\d{1,2}\s*[点时]|今天|明天|昨天|后天|周[一二三四五六日天])/gu;
const AMOUNT_RE = /\d+(?:\.\d+)?\s*(?:元|块钱|块|万|w|k|K)/gu;
const STRONG_NEGATION_RE = /不会|不可能|绝无|并未|从来(?:不|没)|绝不|并未/gu;
const PROMISE_RE = /一定|保证|答应|绝对|肯定|下次一定|说话算话|包在我身上/gu;

const RISK_PATTERNS: Array<[RegExp, string]> = [
  [NUMBER_RE, 'number'],
  [DATE_TIME_RE, 'date_time'],
  [AMOUNT_RE, 'amount'],
  [STRONG_NEGATION_RE, 'negation'],
  [PROMISE_RE, 'promise']
];

function tokenSet(text: string, pattern: RegExp): Set<string> {
  const out = new Set<string>();
  for (const match of text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? []) {
    out.add(match.trim());
  }
  return out;
}

/**
 * Tokens of the spoken script that never appear in the canonical reply text.
 * Only high-risk classes are compared; ordinary phrasing differences are the
 * whole point of an independent script and are ignored.
 */
export function semanticRiskReport(spoken: string, canonical: string): SemanticRiskReport {
  const risks: string[] = [];
  for (const [pattern, label] of RISK_PATTERNS) {
    const spokenTokens = tokenSet(spoken, pattern);
    if (spokenTokens.size === 0) continue;
    const canonicalTokens = tokenSet(canonical, pattern);
    for (const token of spokenTokens) {
      if (!canonicalTokens.has(token)) {
        risks.push(`${label}:${token}`);
        break;
      }
    }
  }
  return { ok: risks.length === 0, risks };
}
