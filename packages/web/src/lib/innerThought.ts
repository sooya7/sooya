/**
 * Inner-thought UI preference (chat side). Purely client-side, stored in
 * localStorage; the server keeps deciding whether thoughts exist at all.
 *
 * Modes:
 *  - off:       nothing is fetched or rendered.
 *  - brief:     a one-line collapsed chip ("⌁ 她在想…") that expands on tap.
 *  - immersive: the thought text is shown expanded by default (still collapsible).
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
    if (stored === 'off' || stored === 'brief' || stored === 'immersive') return stored;
  } catch {
    /* private mode */
  }
  return DEFAULT_MODE;
}

export function setInnerThoughtMode(mode: InnerThoughtMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* private mode */
  }
}

export function nextInnerThoughtMode(current: InnerThoughtMode): InnerThoughtMode {
  const order: InnerThoughtMode[] = ['off', 'brief', 'immersive'];
  return order[(order.indexOf(current) + 1) % order.length]!;
}

/**
 * Keeps the chip to 1–3 sentences so an immersive thought can never blow up the
 * message row; the full text stays available as a tooltip.
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
