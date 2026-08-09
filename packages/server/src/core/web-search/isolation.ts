import type { ChatMessage } from '../types.js';

export function isWebSearchAnswer(message: ChatMessage): boolean {
  return message.role === 'assistant'
    && message.content.some((part) => part.meta?.webSearchUsed === true);
}

/** Search-derived assistant facts are deliberately excluded from durable memory extraction. */
export function textForMemoryExtraction(message: ChatMessage | undefined): string {
  if (!message || isWebSearchAnswer(message)) return '';
  return message.content
    .map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'audio' ? part.transcript ?? '' : '')
    .filter(Boolean)
    .join('\n');
}

/** Keep turn continuity in summaries without freezing time-sensitive search claims as durable facts. */
export function renderMessageForSummary(message: ChatMessage): string {
  if (isWebSearchAnswer(message)) return 'SOOYA: （联网搜索回答，具体实时事实未写入长期摘要）';
  const who = message.role === 'assistant' ? 'SOOYA' : '用户';
  const bits: string[] = [];
  for (const part of message.content) {
    if (part.status === 'failed') continue;
    if (part.type === 'text' && part.text) bits.push(part.text);
    else if (part.type === 'audio') bits.push(part.transcript ? `(语音)${part.transcript}` : '(语音)');
    else if (part.type === 'sticker') bits.push('(表情包)');
    else if (part.type === 'image') bits.push('(图片)');
    else if (part.type === 'file') bits.push('(文件)');
  }
  if (bits.length === 0) return '';
  return `${who}: ${bits.join(' ')}`;
}
