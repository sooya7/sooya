import { dateLabel } from '../lib/messageGrouping.js';

export function DateSeparator({ iso, timeZone }: { iso: string; timeZone: string }) {
  return <div className="date-separator" data-testid="date-separator" role="separator"><span>{dateLabel(iso, new Date(), timeZone)}</span></div>;
}
