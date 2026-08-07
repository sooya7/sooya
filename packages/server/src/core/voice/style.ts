/**
 * Persona speech style (§85): probabilistic habits for spoken scripts, fed
 * into the script prompt. Kept as a plain config object so the admin panel
 * can edit it; all fields are optional hints, never templates.
 */

export interface PersonaSpeechStyle {
  preferredSentenceLength: 'short' | 'medium';
  maxVoiceSeconds: number;
  directness: number;      // 0..1
  softness: number;        // 0..1
  warmth: number;          // 0..1
  expressiveness: number;  // 0..1
  humor: number;           // 0..1
  hesitation: number;      // 0..1
  allowedFillers: string[];
  allowedHesitations: string[];
  affectionateTerms: string[];
  avoidedPhrases: string[];
  avoidedPatterns: string[];
  openingPreferences: string[];
  endingPreferences: string[];
}

export const DEFAULT_SPEECH_STYLE: PersonaSpeechStyle = {
  preferredSentenceLength: 'short',
  maxVoiceSeconds: 35,
  directness: 0.64,
  softness: 0.78,
  warmth: 0.82,
  expressiveness: 0.52,
  humor: 0.38,
  hesitation: 0.24,
  allowedFillers: ['嗯', '反正', '就是'],
  allowedHesitations: ['怎么说呢', '这个嘛'],
  affectionateTerms: [],
  avoidedPhrases: ['从目前的情况来看', '综合而言', '建议你', '基于上述信息', '首先需要明确的是'],
  avoidedPatterns: ['每句话都以我觉得开头', '连续堆叠语气词'],
  openingPreferences: [],
  endingPreferences: []
};

/** Renders the style into a compact prompt hint (Chinese, no JSON needed). */
export function stylePromptHints(style: PersonaSpeechStyle | null | undefined): string {
  if (!style) return '用自然、口语化、像一对一私聊里按住语音键说话的方式。';
  const hints: string[] = [];
  if (style.preferredSentenceLength === 'short') hints.push('句子要短，一次只说一个意思');
  if (style.hesitation > 0.5) hints.push('可以有一点自然的犹豫和停顿');
  if (style.warmth > 0.7) hints.push('语气要亲近、有温度');
  if (style.humor > 0.5) hints.push('可以带一点轻松的调侃');
  if (style.allowedHesitations.length) hints.push(`可以偶尔用「${style.allowedHesitations.slice(0, 3).join('」「')}」这类口头语`);
  if (style.avoidedPhrases.length) hints.push(`避免使用：${style.avoidedPhrases.slice(0, 6).join('、')}`);
  return hints.join('；') + '。不要堆语气词，不要像朗读或客服。';
}
