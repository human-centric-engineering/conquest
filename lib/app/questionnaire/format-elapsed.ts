/**
 * `mm:ss` for a wait that is still running.
 *
 * Shared by every ConQuest surface that proves a long request is still alive: the admin upload /
 * extraction tickers (`StatusTicker`, `ExtractionProgress`) and the respondent turn indicator
 * (`TurnProgress`). It was private to the ticker until the respondent surface needed the same
 * clock, and two copies of a format that must stay identical across surfaces is a drift waiting
 * to happen.
 *
 * Takes whole seconds, not milliseconds — every caller owns a once-a-second interval, so seconds
 * are what they have. (The platform's `mic-button` has its own ms-based variant for a recording
 * timer; that one is Sunrise's and deliberately left alone.)
 *
 * Pure — no React, no DOM.
 */

/** Whole seconds as zero-padded `mm:ss`. Negative input clamps to `00:00`. */
export function formatElapsed(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
