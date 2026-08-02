import type { ChatMessage } from './types.js';
import { shouldStartDateSeparator, userTimeZone } from './messageGrouping.js';

/*
 * 虚拟滚动用的消息高度启发式估算：只用于滚动条总长和向前翻页时的位移补偿，
 * 实际高度由 @tanstack/react-virtual 的 measureElement 实测覆盖，所以这里是
 * 「够用即可」的粗略值，不必精确到像素。数值来自 styles.css 实际尺寸。
 */
const LINE_HEIGHT = 22.5; // body 15px × line-height 1.5
const BUBBLE_V_PADDING = 18; // .bubble padding 9px 上下
const CHARS_PER_LINE = 40; // 气泡内宽折中（CJK ~34/行，ASCII ~70/行）
const BUBBLES_GAP = 6;
const MSG_BODY_GAP = 4;
const MSG_META_H = 18;
const REPLY_PREVIEW_H = 44;
const ITEM_PAD_BOTTOM = 10; // 复刻 .messages 的 gap:10px，计入测高
const DATE_SEPARATOR_H = 35;
const IMAGE_MAX_W = 260; // .image-part max-width
const IMAGE_MAX_H = 320; // .image-part img max-height
const STICKER_H = 108; // .sticker-part
const AUDIO_H = 48;
const FILE_H = 50;
const SYSTEM_H = 26;

function textHeight(text: string): number {
  const lines = Math.max(1, Math.ceil([...text].length / CHARS_PER_LINE));
  return BUBBLE_V_PADDING + lines * LINE_HEIGHT;
}

export function estimateMessageHeight(message: ChatMessage, previous: ChatMessage | null, timeZone = userTimeZone()): number {
  if (message.role === 'system') {
    return SYSTEM_H + (shouldStartDateSeparator(previous, message, timeZone) ? DATE_SEPARATOR_H : 0) + ITEM_PAD_BOTTOM;
  }
  const visible = message.content.filter((part) => part.type !== 'system');
  let partsHeight = 0;
  for (const part of visible) {
    switch (part.type) {
      case 'text':
        partsHeight += textHeight(part.text ?? '');
        break;
      case 'image': {
        const media = part.media;
        const ratio = media?.width && media.height ? media.width / media.height : 1;
        partsHeight += Math.min(IMAGE_MAX_W / ratio, IMAGE_MAX_H);
        break;
      }
      case 'sticker':
        partsHeight += STICKER_H;
        break;
      case 'audio':
        partsHeight += AUDIO_H;
        break;
      case 'file':
        partsHeight += FILE_H;
        break;
      default:
        break;
    }
  }
  if (visible.length > 1) partsHeight += BUBBLES_GAP * (visible.length - 1);
  let height = partsHeight + MSG_BODY_GAP + MSG_META_H;
  if (message.replyTo) height += REPLY_PREVIEW_H;
  if (shouldStartDateSeparator(previous, message, timeZone)) height += DATE_SEPARATOR_H;
  return height + ITEM_PAD_BOTTOM;
}
