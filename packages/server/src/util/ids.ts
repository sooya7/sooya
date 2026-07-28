import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function randomId(len = 16): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Monotonic-ish sortable id: base36 timestamp + randomness. */
export function sortableId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomId(10)}`;
}

export const newMessageId = () => sortableId('msg');
export const newMediaId = () => sortableId('media');
export const newMemoryId = () => sortableId('mem');
export const newJobId = () => sortableId('job');
export const newEventId = () => sortableId('evt');
export const newSummaryId = () => sortableId('sum');
export const newStickerId = () => sortableId('sticker');

export function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}
