/**
 * Compact date/time formatting for dense admin tables.
 *
 * Splits a timestamp into a short date + a time, dropping seconds and — when the timestamp falls in the
 * current year — the year too, so a "Created" column reads `6 Jul · 18:01` instead of
 * `06/07/2026, 18:01:03`. `full` carries the complete locale string for a hover tooltip. Pure + Intl-only,
 * so it is safe in both server and client components.
 */

export interface CompactDateTime {
  /** Short date, e.g. `6 Jul` (current year) or `6 Jul 2025` (other years). */
  date: string;
  /** 24-hour time without seconds, e.g. `18:01`. */
  time: string;
  /** Full locale date+time, for a title/tooltip. */
  full: string;
}

export function formatCompactDateTime(iso: string, now: Date = new Date()): CompactDateTime {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '—', time: '', full: '' };
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString(
    undefined,
    sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' }
  );
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return { date, time, full: d.toLocaleString() };
}
