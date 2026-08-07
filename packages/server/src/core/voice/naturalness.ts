import type { VoiceMode, VoiceNaturalnessReport } from './types.js';

/**
 * Rule-based naturalness checks for spoken scripts (§87). Pure functions so
 * they are trivially testable without a model.
 */

/** Strips punctuation / common fillers, then builds 2-3 char n-grams. */
function ngramSet(text: string, n: number): Set<string> {
  const cleaned = text
    .replace(/[\s，。！？、；：,.!?;:'"「」『』（）()【】《》…—～~]/gu, '')
    .replace(/嗯|啊|呃|那个|这个|就是|反正|其实|怎么说呢/gu, '');
  const out = new Set<string>();
  for (let i = 0; i <= cleaned.length - n; i++) out.add(cleaned.slice(i, i + n));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter++;
  return inter / (a.size + b.size - inter);
}

function longestCommonSubstringRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  let best = 0;
  const window = Math.min(short.length, 60);
  for (let size = window; size >= 4 && best === 0; size--) {
    for (let i = 0; i + size <= short.length; i++) {
      if (long.includes(short.slice(i, i + size))) {
        best = size;
        break;
      }
    }
  }
  return best / Math.max(1, long.length);
}

/** 0..1 literal overlap between the spoken script and the text reply. */
export function voiceTextSimilarity(spoken: string, text: string): number {
  if (!spoken || !text) return 0;
  const a = ngramSet(spoken, 2);
  const b = ngramSet(text, 2);
  return 0.6 * jaccard(a, b) + 0.4 * longestCommonSubstringRatio(spoken, text);
}

const FORMAL_PHRASES = [
  '从目前的情况来看',
  '综合而言',
  '综合上述',
  '基于你提供的信息',
  '基于上述信息',
  '首先需要明确的是',
  '需要注意的是',
  '综上所述',
  '换句话说',
  '总而言之',
  '在某种程度上',
  '与此同时',
  '不难发现',
  '建议你',
  '由此可见'
];

const MARKDOWN_RESIDUE = /[#*`>|]|\]\(|\n{3,}/u;

/** Splits on sentence-ending punctuation, keeping CJK + latin input safe. */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\n]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function estimateSpeechSeconds(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9]+/gu) ?? []).length;
  return Math.max(1, Math.round((cjk / 4.2 + latin * 0.3) * 10) / 10);
}

const FILLERS = /嗯|啊|呃|那个|这个|就是|反正|其实|怎么说呢|你知道吧|对吧|嘛|啦|哦/g;

/**
 * Full naturalness report with acceptance verdict per §87 thresholds.
 * `mode` adjusts the similarity threshold: complement must differ from the
 * text, summary may be closer, read_aloud is exempt.
 */
export function assessNaturalness(
  spokenText: string,
  textReply: string,
  mode: VoiceMode,
  opts: { maxVoiceSeconds?: number } = {}
): VoiceNaturalnessReport {
  const sentences = splitSentences(spokenText);
  const lengths = sentences.map((s) => s.length);
  const averageSentenceChars = lengths.length
    ? Math.round((lengths.reduce((a, b) => a + b, 0) / lengths.length) * 10) / 10
    : 0;
  const maxSentenceChars = lengths.length ? Math.max(...lengths) : 0;
  const formalPhraseCount = FORMAL_PHRASES.filter((p) => spokenText.includes(p)).length;
  const fillerMatches = spokenText.match(FILLERS);
  const fillerDensity = spokenText.length ? Math.round(((fillerMatches?.length ?? 0) * 2 / spokenText.length) * 1000) / 1000 : 0;
  const openings = sentences.slice(0, 5).map((s) => s.slice(0, 2));
  const repeatedOpeningScore = openings.length >= 2
    ? Math.max(0, openings.length - new Set(openings).size)
    : 0;
  const markdownResidueCount = (spokenText.match(MARKDOWN_RESIDUE) ?? []).length;
  const similarity = mode === 'read_aloud' ? 1 : voiceTextSimilarity(spokenText, textReply);
  const estimatedSeconds = estimateSpeechSeconds(spokenText);
  const maxSeconds = opts.maxVoiceSeconds ?? 60;

  const reasons: string[] = [];
  const simCap = mode === 'complement' ? 0.65 : mode === 'summary' ? 0.75 : 1;
  if (mode === 'complement' && similarity > 0.45) reasons.push(`similarity:${similarity.toFixed(2)}>0.45`);
  if (similarity > simCap) reasons.push(`similarity:${similarity.toFixed(2)}>${simCap}`);
  if (averageSentenceChars > 30) reasons.push(`avg_sentence:${averageSentenceChars}`);
  if (maxSentenceChars > 55) reasons.push(`max_sentence:${maxSentenceChars}`);
  if (formalPhraseCount > 0) reasons.push(`formal:${formalPhraseCount}`);
  if (fillerDensity > 0.12) reasons.push(`fillers:${fillerDensity.toFixed(3)}`);
  if (repeatedOpeningScore > 1) reasons.push(`repeated_openings:${repeatedOpeningScore}`);
  if (markdownResidueCount > 0) reasons.push(`markdown:${markdownResidueCount}`);
  if (estimatedSeconds > maxSeconds) reasons.push(`duration:${estimatedSeconds}s>${maxSeconds}s`);

  return {
    textSimilarity: Math.round(similarity * 1000) / 1000,
    averageSentenceChars,
    maxSentenceChars,
    formalPhraseCount,
    fillerDensity,
    repeatedOpeningScore,
    markdownResidueCount,
    estimatedSeconds,
    accepted: reasons.length === 0,
    reasons
  };
}
