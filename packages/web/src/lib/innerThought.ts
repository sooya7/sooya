/**
 * Inner-thought UI preference (chat side).
 *
 * The old three-mode control (off / brief / immersive) was exposed beside
 * every thought, which made a per-message display affordance look like a
 * meaningful action. The chat now has one predictable interaction: thoughts
 * start collapsed and expand/collapse when tapped. Legacy values are accepted
 * only so existing localStorage does not break after upgrade.
 */
export type InnerThoughtMode = 'off' | 'brief' | 'immersive';

const STORAGE_KEY = 'sooya.inner-thought-mode';
const DEFAULT_MODE: InnerThoughtMode = 'brief';

export const INNER_THOUGHT_MODES: ReadonlyArray<{ value: InnerThoughtMode; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'brief', label: '简短' },
  { value: 'immersive', label: '沉浸' }
];

export function getInnerThoughtMode(): InnerThoughtMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Migrate the old always-expanded mode to the single collapsed-by-default UI.
    if (stored === 'immersive') {
      localStorage.setItem(STORAGE_KEY, DEFAULT_MODE);
      return DEFAULT_MODE;
    }
    if (stored === 'off' || stored === 'brief') return stored;
  } catch {
    /* private mode */
  }
  return DEFAULT_MODE;
}

export function setInnerThoughtMode(mode: InnerThoughtMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode === 'immersive' ? DEFAULT_MODE : mode);
  } catch {
    /* private mode */
  }
}

/** Kept for compatibility with the existing component; the mode button is no longer shown. */
export function nextInnerThoughtMode(current: InnerThoughtMode): InnerThoughtMode {
  return current === 'off' ? 'brief' : 'off';
}

/**
 * Keeps the chip to 1–3 sentences so an expanded thought cannot blow up the
 * message row.
 */
export function limitToThreeSentences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const parts = trimmed.split(/(?<=[。！？!?.])/u);
  const sentences: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    sentences.push(part.trim());
    if (sentences.length >= 3) break;
  }
  const joined = sentences.join(' ').trim();
  return joined.length <= 280 ? joined : `${joined.slice(0, 280)}…`;
}
