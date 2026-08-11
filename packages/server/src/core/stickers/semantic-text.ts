import type { Sticker } from '../../db/repos/sticker.repo.js';

/** One canonical semantic document shared by FTS, embeddings, picker and UI. */
export function stickerSemanticText(sticker: Sticker): string {
  return [
    `名称：${sticker.name}`,
    `标准含义：${sticker.description || sticker.emotion || sticker.name}`,
    `图片文字：${sticker.imageText || '无'}`,
    `标签：${sticker.tags.length ? sticker.tags.join(' ') : '无'}`,
    `用户自己的常见用法：${sticker.userMeaning || '暂无稳定个人用法'}`
  ].join('\n');
}
