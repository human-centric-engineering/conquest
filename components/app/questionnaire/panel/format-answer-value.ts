/**
 * Presentational formatter for an answer value in the panel (F7.2).
 *
 * The stored value is `unknown` (string | number | boolean | array for multi-choice,
 * etc.). This renders a compact, human-readable string for the panel — arrays join
 * with commas, booleans read Yes/No, objects fall back to JSON. Presentational only;
 * no validation (the value was validated at capture).
 */

export function formatAnswerValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((v) => formatAnswerValue(v)).join(', ');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value.trim() === '' ? '—' : value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  // Objects (and any other shape) — JSON, with a quiet fallback if it can't serialise.
  try {
    return JSON.stringify(value) ?? '—';
  } catch {
    return '—';
  }
}
