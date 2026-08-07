/**
 * TTS text normalization (§90). Keeps the user-visible transcript (spokenText)
 * separate from what is actually sent to the synthesizer (synthesisText).
 */

export interface NormalizedVoiceText {
  spokenText: string;
  synthesisText: string;
}

/** Bracketed protocol markers the model may still emit. */
const PROTOCOL_MARKER_RE = /\[\[voice[^\]]*\]\]|\[\/voice\]|\[\[voice-mode=[^\]]*\]\]/gu;

/** URLs and bare links. */
const URL_RE = /https?:\/\/[^\s，。；、！？!?）)】】》》]+/gu;

const LIST_RE = /^\s*[-*•·]\s+/gmu;
const NUMBERED_LIST_RE = /^\s*\d+[.、)]\s+/gmu;

const EXCESS_ELLIPSIS_RE = /(?:\.{3,}|…{2,})/gu;

const BULLET_LINE_RE = /^[-*•·]\s+/gmu;

export function normalizeVoiceText(spokenText: string): NormalizedVoiceText {
  let text = spokenText ?? '';

  // 1. Strip protocol markers.
  text = text.replace(PROTOCOL_MARKER_RE, '');

  // 2. Bullet / numbered lists become plain sentences.
  text = text
    .replace(LIST_RE, '')
    .replace(NUMBERED_LIST_RE, '');

  // 3. Inline markdown residue.
  text = text.replace(/[#*`>|~]/gu, '').replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1');

  // 4. URLs: don't read them aloud.
  text = text.replace(URL_RE, '链接我放在文字里了');

  // 5. Bracketed content (括号) — keep short asides, drop long inserts.
  text = text.replace(/（[^）]{40,}）/gu, '，这个细节文字里写了，');
  text = text.replace(/\([^)]{40,}\)/gu, ', details in text, ');

  // 6. Emoji and symbols that TTS would garble.
  text = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');

  // 7. Excessive ellipsis → single.
  text = text.replace(EXCESS_ELLIPSIS_RE, '……');

  // 8. Collapse whitespace, drop empty bullet remnants.
  text = text.replace(BULLET_LINE_RE, '').replace(/[ \t]+/gu, ' ').replace(/\n{3,}/gu, '\n\n').trim();

  // 9. Split overlong sentences into shorter ones at commas when a single
  //    sentence would otherwise be unreadable.
  const sentences = text.split(/(?<=[。！？!?])/u);
  text = sentences
    .map((sentence) => {
      const clean = sentence.trim();
      if (clean.length <= 45) return clean;
      const parts = clean.split(/(?<=[，、；])/u);
      if (parts.length < 2) return clean;
      return parts.map((p) => p.trim()).join('\n');
    })
    .join('')
    .replace(/\n{2,}/gu, '\n')
    .trim();

  return { spokenText: (spokenText ?? '').trim(), synthesisText: text };
}

/** Colloquial-rewrite fallback used when no model is available for the script. */
export function ruleBasedColloquial(text: string, maxChars: number): string {
  let t = (text ?? '').trim();
  // Strip markdown-like structure.
  t = t.replace(/[#*`>|]/gu, '');
  // Shorten long sentences at conjunctions.
  t = t
    .replace(/([^。！？!?]{25,45}?)[，、](?=[^，、]{0,20}[，。！？!?]|$)/gu, '$1，\n')
    .replace(/\n+/gu, '，');
  // Trim to max chars at a sentence boundary.
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars);
    const last = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    t = (last >= maxChars * 0.5 ? cut.slice(0, last + 1) : cut).trim();
    if (t.length < maxChars * 0.3) t = cut.trim();
  }
  return t.trim() || text.slice(0, maxChars);
}
