const OPEN_CLOSE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['(', ')'],
  ['（', '）'],
  ['[', ']'],
  ['【', '】'],
  ['「', '」'],
  ['『', '』']
];

/**
 * Visible thoughts are public-facing copy, so a provider fragment is worse
 * than no thought at all. The prompt asks for Chinese prose; require a small
 * amount of complete Chinese content and reject visibly truncated brackets.
 *
 * This intentionally stays conservative. It is not a semantic judge, only a
 * debris filter for outputs such as `Won`, `(心`, empty wrappers, or a response
 * cut off halfway through an opening bracket.
 */
export function isDisplayableThoughtText(value: string): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;

  const chars = [...text];
  const hanCount = chars.filter((char) => /\p{Script=Han}/u.test(char)).length;
  const meaningfulCount = chars.filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
  if (chars.length < 4 || hanCount < 2 || meaningfulCount < 3) return false;

  for (const [open, close] of OPEN_CLOSE_PAIRS) {
    const opens = chars.filter((char) => char === open).length;
    const closes = chars.filter((char) => char === close).length;
    if (opens !== closes) return false;
  }
  return true;
}
