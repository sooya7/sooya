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

const STICKER_PATTERNS = [
  /发(?:个|一个|张|一张)?(?:.{0,12})?表情/,
  /来(?:个|一个|张)?(?:.{0,12})?表情/,
  /表情包/,
  /send.*sticker/i,
  /斗图/
];
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
  selfImagePrompt?: string | null;
  voice?: boolean;
  voiceOnly?: boolean;
  stickerOnly?: boolean;
  /** The mood she asked for, e.g. `[[voice:emotion=happy]]`. */
  voiceEmotion?: string;
}

/**
 * Reads the mood out of a voice marker argument. Kept lenient about spacing and
 * case because the model writes these by hand, but the word itself is bounded so
 * a stray sentence cannot ride along into a provider request.
 */
export function parseEmotionArg(arg: string | null | undefined): string | null {
  // The lookahead makes an over-long run fail outright: silently truncating a
  // 40-character blob to 24 would hand a provider a word nobody wrote.
  const m = /emotion\s*=\s*([A-Za-z_-]{1,24})(?![A-Za-z_-])/i.exec(arg ?? '');
  return m ? m[1]!.toLowerCase() : null;
}

const MARKER_KINDS = ['sticker', 'image', 'image-self', 'voice', 'voice-only', 'sticker-only', '表情包', '图片', '语音'] as const;
const KIND_ALT = 'image-self|sticker-only|voice-only|sticker|image|voice|表情包|图片|语音';

/**
 * The prompt teaches `[[marker]]`, but models emit the single-bracket form and
 * attribute syntax (`[voice:emotion=gentle]`) often enough that treating those
 * as literal text leaks protocol into the conversation. Accept one or two
 * brackets on each side; unknown attributes are parsed and discarded.
 */
const MARKER_RE = new RegExp(String.raw`\[{1,2}\s*(${KIND_ALT})\s*(?::\s*([^\]]*))?\s*\]{1,2}`, 'gi');

/** Whole-span form of {@link MARKER_RE}, for deciding on a buffered chunk. */
const MARKER_EXACT_RE = new RegExp(String.raw`^\[{1,2}\s*(?:${KIND_ALT})\s*(?::\s*[^\]]*)?\s*\]{1,2}$`, 'i');

/** How far past a `[` to wait for its `]` before giving up and emitting text. */
const MARKER_LOOKAHEAD = 48;

/**
 * A model image prompt can be much longer than the normal bracket lookahead.
 * Once the prefix is unambiguously a protocol marker, keep it private until it
 * closes; if a broken provider never closes it, discard the bounded buffer
 * instead of ever showing the protocol to the user.
 */
const MAX_MARKER_BUFFER = 8_192;

/**
 * True for a truncated marker such as "[voic" or "[[sticker:开" — that is, a
 * span that is still capable of becoming a marker once more text arrives.
 * Anything already ruled out (`[备注`, `[这是一段正文`) must return false so the
 * streaming filter releases it instead of holding prose hostage.
 */
function isPartialMarker(rest: string): boolean {
  const m = /^\[{1,2}\s*([a-z\u4e00-\u9fff-]*)\s*(.?)/i.exec(rest);
  if (!m) return false;
  const kind = (m[1] ?? '').toLowerCase();
  // Text follows the kind: only ':' can still lead to a marker, and only when
  // the kind is already complete (the rest is then a free-form argument).
  if (m[2]) return m[2] === ':' && MARKER_KINDS.some((k) => k === kind);
  // Nothing after the kind yet, so any marker it prefixes is still reachable.
  return MARKER_KINDS.some((k) => k.startsWith(kind));
}

/**
 * An unterminated marker at the very end, such as "...[[sticker:开".
 * Any unmatched opening marker is buffered/removed, so a partial protocol
 * marker is never shown to the user.
 */
const TRAILING_PARTIAL_RE = /\[\[[^\]]*$/;

/** A truncated single-bracket marker at the very end, such as "...[voic". */
const TRAILING_SINGLE_PARTIAL_RE = new RegExp(String.raw`\[\s*(?:${KIND_ALT})?[a-z-]*\s*(?::[^\]]*)?$`, 'i');

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
  let cleaned = partial ? raw.slice(0, partial.index) : raw;
  const singlePartial = TRAILING_SINGLE_PARTIAL_RE.exec(cleaned);
  if (singlePartial && isPartialMarker(singlePartial[0])) cleaned = cleaned.slice(0, singlePartial.index);
  const text = cleaned
    .replace(MARKER_RE, (_m, kind: string, arg?: string) => {
      const k = canonicalMarkerKind(kind);
      const value = (arg ?? '').trim();
      if (k === 'sticker') directives.sticker = value || 'auto';
      else if (k === 'image') directives.imagePrompt = value || null;
      else if (k === 'image-self') directives.selfImagePrompt = value || null;
      else if (k === 'voice') {
        directives.voice = true;
        const mood = parseEmotionArg(value);
        if (mood) directives.voiceEmotion = mood;
      } else if (k === 'voice-only') {
        directives.voice = true;
        directives.voiceOnly = true;
        const mood = parseEmotionArg(value);
        if (mood) directives.voiceEmotion = mood;
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

function canonicalMarkerKind(kind: string): 'sticker' | 'image' | 'image-self' | 'voice' | 'voice-only' | 'sticker-only' {
  const normalized = kind.toLowerCase();
  if (normalized === '表情包') return 'sticker';
  if (normalized === '图片') return 'image';
  if (normalized === '语音') return 'voice';
  if (normalized === 'image-self') return 'image-self';
  return normalized as 'sticker' | 'image' | 'image-self' | 'voice' | 'voice-only' | 'sticker-only';
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
      const open = this.pending.indexOf('[');
      if (open < 0) {
        out += this.pending;
        this.pending = '';
        break;
      }
      out += this.pending.slice(0, open);
      this.pending = this.pending.slice(open);

      const close = this.pending.indexOf(']');
      if (close < 0) {
        // Still waiting for the closing bracket. A known marker prefix gets a
        // larger bounded buffer because image prompts are commonly hundreds of
        // characters long; ordinary bracketed prose keeps the short lookahead.
        if (isPartialMarker(this.pending)) {
          if (this.pending.length > MAX_MARKER_BUFFER) this.pending = '';
        } else if (this.pending.length > MARKER_LOOKAHEAD) {
          out += this.pending;
          this.pending = '';
        }
        break;
      }

      // A marker may close with ']' or ']]'. When the ']' is the last byte we
      // have, a second one may still be coming in the next chunk, so wait
      // rather than emit the leftover bracket as text. flush() decides if the
      // stream ends here.
      if (close === this.pending.length - 1 && MARKER_EXACT_RE.test(this.pending)) break;

      const end = this.pending[close + 1] === ']' ? close + 2 : close + 1;
      const span = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      if (!MARKER_EXACT_RE.test(span)) out += span;
    }
    return out;
  }

  /** Flush whatever is left (an unterminated marker is dropped). */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    if (rest === '[') return '[';
    if (MARKER_EXACT_RE.test(rest) || isPartialMarker(rest)) return '';
    return rest;
  }
}

