/**
 * Shared timing constants for the admin sessions surfaces.
 *
 * These live together because the same underlying state is watched from more than one place —
 * the drawer's Report tab and the standalone re-run card both poll a generating report, and
 * previously did so at different intervals (4000 vs 3000) purely by accident.
 */

/** How often to re-poll while a report is `queued` / `processing`. */
export const REPORT_POLL_MS = 4_000;

/** How long a "Copied" confirmation stays visible before clearing itself. */
export const COPIED_FEEDBACK_MS = 2_000;
