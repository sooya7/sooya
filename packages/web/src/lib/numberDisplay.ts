/** Stable, compact number formatting for the small read-only status surfaces. */
export function formatTemperature(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${Object.is(Math.round(value), -0) ? 0 : Math.round(value)}°C`;
}

export function formatVital(key: string, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (key === 'sleep_debt') {
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} 小时`;
  }
  return String(Math.round(value));
}

export function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${Math.round(value)}%`;
}

export function formatOneDecimal(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
