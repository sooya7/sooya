/**
 * Two-way directive protocol.
 *
 * 1. User directives are parsed from the user's own text ("发个表情"、"用语音说").
 * 2. Model directives are inline markers the model may emit while streaming,
 *    e.g. [[sticker:开心]] / [[image:一只在窗台睡觉的猫]] / [[voice]] / [[voice-only]].
 *    They are stripped from the visible text.
 *
 * This keeps multimedia decisions model-driven without requiring tool-calling
 * support from the provider.
 */

export interface UserDirectives {
  wantSticker?: boolean;
  wantImage?: boolean;
  imagePrompt?: string | null;
  wantVoice?: boolean;
  voiceOnly?: boolean;
  stickerOnly?: boolean;
  noSticker?: boolean;
  noVoice?: boolean;
  anotherSticker?: boolean;
}

const STICKER_PATTERNS = [/发(?:个|一个|张|一张)?表情/, /来(?:个|一个|张)?表情/, /表情包/, /send.*sticker/i, /斗图/];
const STICKER_ONLY_PATTERNS = [/只发表情/, /光发表情/, /只要表情/, /sticker only/i];
const ANOTHER_STICKER_PATTERNS = [/换(?:一)?个表情/, /再来(?:一)?个表情/, /换个表情包/, /another sticker/i, /换一张/];
const NO_STICKER_PATTERNS = [/不要(?:发)?表情/, /别发表情/, /不用表情/, /no sticker/i, /别斗图/];

const VOICE_PATTERNS = [/用语音(?:说|讲|回|发)?/, /语音(?:说|回复|回答|讲)/, /发(?:个|条|段)?语音/, /读出来/, /念(?:出来|一下)/, /voice message/i, /say it (?:out loud|aloud)/i];
const VOICE_ONLY_PATTERNS = [/只发语音/, /只要语音/, /只用语音/, /光发语音/, /voice only/i];
const NO_VOICE_PATTERNS = [/不要(?:发)?语音/, /别发语音/, /不用语音/, /no voice/i];

const IMAGE_PATTERNS = [
  /(?:生成|画|做|来|给我).{0,6}(?:一)?(?:张|幅|个)?(?:图片?|画|插画|海报)/,
  /生成图/,
  /画(?:一)?(?:张|幅)/,
  /draw (?:me )?(?:a|an)?/i,
  /generate (?:an? )?image/i
];
const IMAGE_PROMPT_EXTRACT = [
  /(?:生成|画|做)(?:一)?(?:张|幅|个)?(?:图片?|画|插画|海报)?[，,:：]?\s*(.+)$/,
  /draw (?:me )?(?:an? )?(.+)$/i,
  /generate (?:an? )?image of (.+)$/i
];

export function parseUserDirectives(text: string): UserDirectives {
  const t = (text ?? '').trim();
  if (!t) return {};
  const d: UserDirectives = {};
  const has = (patterns: RegExp[]) => patterns.some((p) => p.test(t));

  if (has(NO_STICKER_PATTERNS)) d.noSticker = true;
  else if (has(ANOTHER_STICKER_PATTERNS)) {
    d.wantSticker = true;
    d.anotherSticker = true;
  } else if (has(STICKER_ONLY_PATTERNS)) {
    d.wantSticker = true;
    d.stickerOnly = true;
  } else if (has(STICKER_PATTERNS)) d.wantSticker = true;

  if (has(NO_VOICE_PATTERNS)) d.noVoice = true;
  else if (has(VOICE_ONLY_PATTERNS)) {
    d.wantVoice = true;
    d.voiceOnly = true;
  } else if (has(VOICE_PATTERNS)) d.wantVoice = true;

  if (has(IMAGE_PATTERNS)) {
    d.wantImage = true;
    for (const p of IMAGE_PROMPT_EXTRACT) {
      const m = p.exec(t);
      if (m?.[1] && m[1].trim().length >= 2) {
        d.imagePrompt = m[1].trim().replace(/[。.!！~]+$/, '');
        break;
      }
    }
    if (!d.imagePrompt) d.imagePrompt = t;
  }
  return d;
}

export interface ModelDirectives {
  sticker?: string | null;
  imagePrompt?: string | null;
  voice?: boolean;
  voiceOnly?: boolean;
  stickerOnly?: boolean;
}

const MARKER_RE = /\[\[\s*(sticker|image|voice|voice-only|sticker-only)\s*(?::\s*([^\]]*))?\]\]/gi;

/**
 * An unterminated marker at the very end of the output, e.g. when the stream
 * was cut off mid-marker ("...[[sticker:开"). It must be removed too, otherwise
 * the raw marker text would be shown to the user and stored in the database.
 */
const TRAILING_PARTIAL_RE = /\[\[\s*(?:s(?:t(?:i(?:c(?:k(?:e(?:r(?:-(?:o(?:n(?:l(?:y)?)?)?)?)?)?)?)?)?)?)?|i(?:m(?:a(?:g(?:e)?)?)?)?|v(?:o(?:i(?:c(?:e(?:-(?:o(?:n(?:l(?:y)?)?)?)?)?)?)?)?)?)?[^\]]*$/i;

export interface StripResult {
  text: string;
  directives: ModelDirectives;
}

/**
 * Removes markers from a completed text and returns what they requested.
 * Handles both complete markers and a truncated one at the end of the stream.
 */
export function stripModelDirectives(raw: string): StripResult {
  const directives: ModelDirectives = {};
  const partial = TRAILING_PARTIAL_RE.exec(raw);
  const cleaned = partial ? raw.slice(0, partial.index) : raw;
  const text = cleaned
    .replace(MARKER_RE, (_m, kind: string, arg?: string) => {
      const k = kind.toLowerCase();
      const value = (arg ?? '').trim();
      if (k === 'sticker') directives.sticker = value || 'auto';
      else if (k === 'image') directives.imagePrompt = value || null;
      else if (k === 'voice') directives.voice = true;
      else if (k === 'voice-only') {
        directives.voice = true;
        directives.voiceOnly = true;
      } else if (k === 'sticker-only') {
        directives.sticker = value || 'auto';
        directives.stickerOnly = true;
      }
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, directives };
}

/**
 * Incremental stripper for streaming: buffers partial markers so a half-written
 * "[[stic" is never shown to the user.
 */
export class StreamingDirectiveFilter {
  private pending = '';

  push(chunk: string): string {
    this.pending += chunk;
    let out = '';
    for (;;) {
      const open = this.pending.indexOf('[[');
      if (open < 0) {
        // Keep a single trailing '[' in case the next chunk completes '[['.
        if (this.pending.endsWith('[')) {
          out += this.pending.slice(0, -1);
          this.pending = '[';
        } else {
          out += this.pending;
          this.pending = '';
        }
        break;
      }
      out += this.pending.slice(0, open);
      const close = this.pending.indexOf(']]', open);
      if (close < 0) {
        this.pending = this.pending.slice(open);
        break;
      }
      this.pending = this.pending.slice(close + 2);
    }
    return out;
  }

  /** Flush whatever is left (an unterminated marker is dropped). */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    if (rest.startsWith('[[')) return '';
    if (rest === '[') return '[';
    return rest;
  }
}
