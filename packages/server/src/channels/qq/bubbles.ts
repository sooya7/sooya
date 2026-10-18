/*
 * 把一条回复拆成几个 QQ 气泡，让她像真人那样一句一句发，而不是一整段客服式长文。
 *
 * 规则保持确定性（同一段文字永远拆成同样的气泡），这样投递重试时
 * text:<i> 进度和 msg_seq 都能对得上，不会重发或漏发。
 */

/** QQ 被动回复同一个 msg_id 的可用次数按 5 次保守估计（文字气泡 + 媒体一起算）。 */
export const MAX_PASSIVE_SENDS = 5;

const LIST_LINE = /^\s*(?:[-*•·]|\d+[.、)）]|[（(]\d+[)）])\s*/;
const LEAD_IN_LINE = /[:：]\s*$/;

export function splitIntoBubbles(text: string, maxBubbles: number): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const limit = Math.max(1, Math.floor(maxBubbles));
  // 代码块拆开就没法看了，整段发。
  if (limit === 1 || normalized.includes('```')) return [normalized];

  const lineChunks = chunkByLines(normalized);
  if (lineChunks.length <= limit) return lineChunks;
  // 行数太多多半是在认真讲事情：退回按空行分段，同一段留在一个气泡里。
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return mergeTail(paragraphs, limit);
}

function chunkByLines(text: string): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let joinNext = false;
  const flush = () => {
    if (current.length > 0) chunks.push(current.join('\n'));
    current = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      joinNext = false;
      continue;
    }
    // 列表项、缩进续行、冒号引出的内容（到空行为止）都跟着上一句走，不单独成泡。
    const attaches = current.length > 0 && (joinNext || LIST_LINE.test(line) || /^\s/.test(line));
    if (!attaches) flush();
    current.push(line);
    joinNext = joinNext || LEAD_IN_LINE.test(line);
  }
  flush();
  return chunks;
}

function mergeTail(chunks: string[], limit: number): string[] {
  if (chunks.length <= limit) return chunks;
  return [...chunks.slice(0, limit - 1), chunks.slice(limit - 1).join('\n\n')];
}

/** 发下一个气泡前停一下，像在打字：短句快、长句慢一点，但不让人干等。 */
export function bubblePauseMs(nextBubble: string): number {
  const chars = [...nextBubble].length;
  return Math.min(2200, Math.max(500, 400 + chars * 45));
}
