/**
 * Duration formatting for execution UI.
 *
 * Accepts two ISO date strings (start/end) and returns a human-readable
 * duration. When `end` is null, uses the current time (for running
 * executions). Returns `'—'` for invalid or missing start dates.
 */

export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(startMs)) return '—';
  const ms = endMs - startMs;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Compact human duration from a millisecond span — for longer spans like a session's beginning-to-end
 * length. Collapses to the largest one or two units: `45s`, `12m`, `1h 5m`, `2d 3h`. Null, negative, or
 * sub-second spans return `'—'` (nothing meaningful to show).
 */
export function formatCompactDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 1000) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}
