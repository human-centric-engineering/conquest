/**
 * Tiny number formatters shared by the Agent Settings Evaluation cards.
 * Pure functions — unit-tested alongside the engine.
 */

/** A USD figure. Small per-call estimates keep 4 d.p.; larger figures 2 d.p. */
export function formatUsd(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** A blended cost-per-million-tokens rate. */
export function formatPerMillion(value: number | null): string {
  if (value === null) return '—';
  return `$${value.toFixed(2)}/M`;
}

/** A signed percentage delta (e.g. "-72%", "+15%"). */
export function formatPct(value: number | null): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(0)}%`;
}

/** A temperature value, or the inherited/default dash. */
export function formatTemperature(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}
