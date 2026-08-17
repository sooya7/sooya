import sharp from 'sharp';
import type { MediaRow } from '../../db/repos/media.repo.js';
import type { MediaStore } from '../../media/store.js';

/*
 * QQ 媒体投递（docs/QQ-BOT-SINGLE-CHANNEL-PLAN.md §11）。
 * 使用 SOOYA 已保存的媒体产物，不重新生成。策略：
 * 1. 分类（图片 1 / 语音 3 / 文件 4）并对 QQ 支持格式做转换（webp → png）
 * 2. 超限 / 不支持的格式由投递层降级（图片/语音缺失可接受；Sticker 转文本）
 * 官方契约（rich-media.html，2026-08 核对）：
 * - file_type: 1 图片（png/jpg） 2 视频（mp4） 3 语音（silk/wav/mp3/flac） 4 文件
 * - 上传 POST /v2/users/{openid}/files，file_data = base64 二进制
 * - 发送 msg_type=7，media = { file_uuid, file_info }
 */

export type QqFileType = 1 | 2 | 3 | 4;

/** 保守上限（官方文档未给统一数值；部署侧如遇失败可在此收紧）。 */
export const QQ_MEDIA_SIZE_LIMITS: Record<'image' | 'audio' | 'file', number> = {
  image: 25 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
  file: 25 * 1024 * 1024
};

const SUPPORTED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif']);
const CONVERTIBLE_IMAGE_MIME = new Set(['image/webp', 'image/avif']);
const SUPPORTED_AUDIO_MIME = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/x-flac',
  'audio/silk'
]);

export interface QqMediaPlan {
  fileType: QqFileType;
  bytes: Buffer;
  mime: string;
  filename: string;
}

export interface QqMediaClassify {
  fileType: QqFileType;
  supported: boolean;
  /** 不支持 / 超限时给投递层的降级理由。 */
  reason?: string;
}

export function classifyQqMedia(row: MediaRow): QqMediaClassify {
  if (row.kind === 'image') {
    if (SUPPORTED_IMAGE_MIME.has(row.mime)) return { fileType: 1, supported: true };
    if (CONVERTIBLE_IMAGE_MIME.has(row.mime)) return { fileType: 1, supported: true, reason: 'convert' };
    return { fileType: 1, supported: false, reason: `unsupported image mime ${row.mime}` };
  }
  if (row.kind === 'sticker') {
    // 贴纸文件本身是图片（png/gif/webp）；按图片投递。
    return { fileType: 1, supported: true, reason: row.mime === 'image/webp' ? 'convert' : undefined };
  }
  if (row.kind === 'audio') {
    if (SUPPORTED_AUDIO_MIME.has(row.mime)) return { fileType: 3, supported: true };
    return { fileType: 3, supported: false, reason: `unsupported audio mime ${row.mime}` };
  }
  return { fileType: 4, supported: true };
}

export function mediaSizeLimit(fileType: QqFileType): number {
  if (fileType === 3) return QQ_MEDIA_SIZE_LIMITS.audio;
  if (fileType === 1) return QQ_MEDIA_SIZE_LIMITS.image;
  return QQ_MEDIA_SIZE_LIMITS.file;
}

/**
 * 从 MediaStore 读取并准备可上传字节：webp/avif 转 png（QQ 图片仅支持 png/jpg/gif）。
 * 返回 null 表示读取失败或超限（由投递层降级，不让整条回复失败）。
 */
export async function prepareQqMedia(mediaStore: MediaStore, row: MediaRow): Promise<QqMediaPlan | null> {
  const classify = classifyQqMedia(row);
  if (!classify.supported) return null;
  const limit = mediaSizeLimit(classify.fileType);
  if (row.bytes > limit) return null;
  const read = await mediaStore.read(row.id);
  if (!read) return null;
  let bytes = read.data;
  let mime = row.mime;
  if (classify.reason === 'convert' && CONVERTIBLE_IMAGE_MIME.has(row.mime)) {
    try {
      bytes = await sharp(read.data).png().toBuffer();
      mime = 'image/png';
    } catch {
      return null;
    }
  }
  return { fileType: classify.fileType, bytes, mime, filename: safeFilename(row) };
}

function safeFilename(row: MediaRow): string {
  const base = `sooya-${row.id.slice(-8)}`;
  const ext = row.mime === 'image/png' ? 'png' : row.mime === 'image/jpeg' ? 'jpg' : row.mime === 'image/gif' ? 'gif' : row.mime.startsWith('audio/mpeg') ? 'mp3' : row.mime === 'audio/wav' || row.mime === 'audio/x-wav' ? 'wav' : 'bin';
  return `${base}.${ext}`;
}