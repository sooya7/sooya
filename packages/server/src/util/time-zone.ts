export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function readParts(at: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const values = Object.fromEntries(formatter.formatToParts(at).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute!, second: values.second! };
}

export function zonedParts(at: Date, timeZone: string): ZonedParts {
  return readParts(at, timeZone);
}

/** Return the zone offset at an instant; invalid zones deliberately throw. */
export function timeZoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = readParts(at, timeZone);
  return Math.round((Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at.getTime()) / 60_000);
}

export function formatZonedDateTime(at: Date, timeZone: string): string {
  const parts = readParts(at, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
}
