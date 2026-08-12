import './innerThought.css';

/**
 * Inner-thought UI is intentionally a single interaction now: a collapsed
 * “她在想…” chip that expands inline on tap.
 *
 * The previous off / brief / immersive preference did not change the content;
 * it only hid the feature or auto-expanded it, while adding a second pill next
 * to every thought. Keep the old exports as compatibility shims for the
 * MessageItem while making the behavior deterministic and clearing stale
 * localStorage values from older releases.
 */
export type InnerThoughtMode = 'off' | 'brief' | 'immersive';

const STORAGE_KEY = 'sooya.inner-thought-mode';

export const INNER_THOUGHT_MODES: ReadonlyArray<{ value: InnerThoughtMode; label: string }> = [
  { value: 'brief', label: '简短' }
];

export function getInnerThoughtMode(): InnerThoughtMode {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  return 'brief';
}

export function setInnerThoughtMode(_mode: InnerThoughtMode): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
}

export function nextInnerThoughtMode(_current: InnerThoughtMode): InnerThoughtMode {
  return 'brief';
}

/**
 * Keeps the inline thought to 1–3 sentences so expansion cannot dominate the
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
