/**
 * Shared truncation utility for trace projections.
 *
 * Used by:
 *  - `@/lib/orchestration/supervisor` (anti-optimism: hide nothing in the easy spot)
 *  - `@/lib/orchestration/trace/render-markdown` (human-readable report)
 *
 * Default strategy is head + middle + tail sampling with elision markers
 * — the model / reader can see where content was cut out, rather than
 * silently losing the middle of a long output.
 *
 * Platform-agnostic: no Next.js imports.
 */

export const DEFAULT_PER_STEP_CAP_BYTES = 4 * 1024;
export const TERMINAL_HEAD_CAP_BYTES = 1024;

/**
 * Sample head + middle + tail of a string when it exceeds `capBytes`.
 * Elision markers tell readers what's missing so they don't pretend
 * they saw the elided content. Returns the original string when small.
 */
export function sampleString(input: string, capBytes: number): string {
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes <= capBytes) return input;
  const sliceBytes = Math.floor(capBytes / 3);
  const head = input.slice(0, sliceBytes);
  const mid = input.slice(
    Math.floor(input.length / 2 - sliceBytes / 2),
    Math.floor(input.length / 2 + sliceBytes / 2)
  );
  const tail = input.slice(-sliceBytes);
  const elidedBytes = bytes - 3 * sliceBytes;
  return (
    `${head}\n` +
    `[…truncated, ${elidedBytes} bytes elided from head/middle boundary…]\n` +
    `${mid}\n` +
    `[…truncated, bytes elided from middle/tail boundary…]\n` +
    `${tail}`
  );
}

/**
 * Serialise an arbitrary step output to a string. JSON-stringify when
 * possible; return an explanatory placeholder when serialisation throws
 * (typically a circular reference).
 */
export function serialiseStepOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch (err) {
    return `(could not serialize step output: ${err instanceof Error ? err.message : 'unknown error'})`;
  }
}
