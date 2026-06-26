/**
 * Client-safe formatters shared by the Diagnostics surfaces.
 */

/** Compact integer with thousands separators (e.g. 12,345). `null`/0 → an em dash. */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}

/** A duration in ms rendered as `820 ms` or `3.4 s`. `null` → em dash. */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** An ISO timestamp rendered short, or em dash. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Map a diagnostics severity to a Badge variant. */
export function severityVariant(severity: string): 'destructive' | 'secondary' | 'outline' {
  if (severity === 'error') return 'destructive';
  if (severity === 'warning') return 'secondary';
  return 'outline';
}
