/** Build a contains pattern whose user input is always interpreted literally. */
export function literalContainsPattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}
