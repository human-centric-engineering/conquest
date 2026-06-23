/**
 * Chat-transcript export — shared formatting helpers (F7.6).
 *
 * Pure, deterministic date/status formatting used by BOTH transcript renderers (the
 * React-PDF document and the plain-text serialiser) so a turn reads identically in either.
 * Timestamps are formatted in **UTC** — the export is generated server-side with no
 * knowledge of the respondent's timezone, and a fixed zone keeps the output deterministic
 * (so the pure builders' tests don't depend on the runner's locale/TZ). The intro copy
 * notes the UTC convention.
 */

/** `en-GB`, UTC: "1 Jun 2026, 10:04". */
const STAMP_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

/** Format an ISO timestamp as a readable UTC date-time, or a dash when absent/unparseable. */
export function formatTranscriptStamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  // `en-GB` renders a narrow no-break space before the time on some ICU builds; normalise to
  // a plain comma + space so the output is byte-stable across environments.
  return STAMP_FORMAT.format(date).replace(/,\s+/, ', ');
}

/** Title-case a lifecycle status slug for the header detail ("completed" → "Completed"). */
export function humaniseSessionStatus(status: string): string {
  if (status.length === 0) return status;
  return status.charAt(0).toUpperCase() + status.slice(1);
}
