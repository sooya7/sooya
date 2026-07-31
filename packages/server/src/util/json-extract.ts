/**
 * Best-effort JSON extraction from model output.
 *
 * The extractors (world, memory) ask for `response_format: json_object`, but
 * that is a declaration about the endpoint, not a guarantee: plenty of
 * OpenAI-compatible endpoints ignore the field, reject it, or accept it and
 * still wrap the object in prose, a code fence or a `<think>` block. When the
 * request falls back to a prompt constraint the output is even less regular.
 *
 * Everything here is tolerant on input and strict on output: it returns a
 * parsed value or `null`, never a half-repaired string.
 */

const FENCE = /```(?:json5?|jsonc)?[ \t]*\r?\n?([\s\S]*?)```/gi;
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const OPEN_THINK = /<think>[\s\S]*$/i;

/** Reasoning traces are prose about JSON, and their braces are not the answer. */
function stripThinking(text: string): string {
  return text.replace(THINK_BLOCK, ' ').replace(OPEN_THINK, ' ').trim();
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      const rest = text.slice(i + 1);
      const next = /^\s*([}\]])/.exec(rest);
      if (next) continue; // comma directly before a close: drop it
    }
    out += ch;
  }
  return out;
}

interface Scan {
  /** Index one past the closing brace, or -1 when it never closed. */
  end: number;
  /** Brackets still open at the end of the input, outermost first. */
  open: string[];
  inString: boolean;
}

/** Walk a fragment starting at `{`, tracking strings so braces inside text do not count. */
function scanObject(text: string, start: number): Scan {
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') open.push(ch);
    else if (ch === '}' || ch === ']') {
      open.pop();
      if (open.length === 0) return { end: i + 1, open, inString: false };
    }
  }
  return { end: -1, open, inString };
}

/**
 * Close a fragment the model got cut off in the middle of.
 *
 * `max_tokens` truncation is the common cause: the object is well formed right
 * up to the point the stream stopped. Closing the open brackets recovers every
 * complete item, which beats throwing the whole extraction away.
 */
function closeTruncated(fragment: string, scan: Scan): string[] {
  const attempts: string[] = [];
  let body = fragment;
  if (scan.inString) {
    // Drop the half-written string rather than inventing its ending.
    const lastQuote = body.lastIndexOf('"');
    if (lastQuote < 0) return attempts;
    body = body.slice(0, lastQuote);
  }
  for (let i = 0; i < 6; i++) {
    const trimmed = body.replace(/[\s,:]+$/, '');
    const rescan = scanObject(trimmed, 0);
    if (rescan.open.length === 0) break;
    const closing = rescan.open
      .slice()
      .reverse()
      .map((b) => (b === '{' ? '}' : ']'))
      .join('');
    attempts.push(trimmed + closing);
    // Next attempt: also drop the last (possibly incomplete) element.
    const cut = Math.max(trimmed.lastIndexOf(','), trimmed.lastIndexOf('{'), trimmed.lastIndexOf('['));
    if (cut <= 0) break;
    body = trimmed.slice(0, cut);
  }
  return attempts;
}

function tryParse(candidate: string): unknown {
  const text = candidate.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to repairs */
  }
  const noTrailing = stripTrailingCommas(text);
  if (noTrailing !== text) {
    try {
      return JSON.parse(noTrailing);
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

function* candidates(raw: string): Generator<string> {
  const text = stripThinking(raw);
  if (!text) return;
  for (const match of text.matchAll(FENCE)) {
    const inner = match[1];
    if (inner && inner.includes('{')) yield inner;
  }
  yield text;
  // Objects embedded in prose: every `{` is a possible start, first parse wins.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const scan = scanObject(text, i);
    if (scan.end > 0) {
      yield text.slice(i, scan.end);
      i = scan.end - 1;
      continue;
    }
    for (const repaired of closeTruncated(text.slice(i), scan)) yield repaired;
    return;
  }
}

/**
 * The first JSON object that can be parsed out of `raw`, or null.
 *
 * Arrays are only returned when the whole output is one; callers here all
 * expect an object envelope, and a bare array in prose is far more often a
 * fragment of an example than the answer.
 */
export function extractJsonObject(raw: string): unknown {
  if (!raw || !raw.includes('{')) return null;
  for (const candidate of candidates(raw)) {
    const parsed = tryParse(candidate);
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') return parsed;
  }
  return null;
}

/**
 * Instruction appended to the system prompt when the endpoint cannot enforce
 * JSON itself. Deliberately short: it is prepended to prompts that already
 * describe the exact schema.
 */
export const JSON_ONLY_INSTRUCTION =
  '只输出一个 JSON 对象本身：不要写解释、前后缀、Markdown 代码块或 <think> 段落，第一个字符必须是 { ，最后一个字符必须是 }。';

/** The same instruction folded into an existing system prompt. */
export function withJsonInstruction(system: string | undefined): string {
  return system ? `${system}\n${JSON_ONLY_INSTRUCTION}` : JSON_ONLY_INSTRUCTION;
}
