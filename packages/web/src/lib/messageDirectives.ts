/**
 * Protocol markers are an implementation detail and must never be rendered
 * as chat text. The server strips them for new replies; the client also
 * applies this small, deliberately narrow filter so historical messages from
 * an older server build cannot expose an image prompt.
 */
const MODEL_MARKER_RE = /\[{1,2}\s*(?:sticker-only|voice-only|sticker|image|voice)(?:\s*:\s*[^\]]*)?\s*\]{1,2}/gi;

export function stripModelDirectivesForDisplay(text: string | null | undefined): string {
  return (text ?? '')
    .replace(MODEL_MARKER_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
