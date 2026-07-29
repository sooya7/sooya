/** Locale-independent identity key shared by migrations, imports and live writes. */
export function worldIdentityKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}
