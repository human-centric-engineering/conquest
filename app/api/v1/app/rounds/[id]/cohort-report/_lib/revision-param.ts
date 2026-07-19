/**
 * Shared `?revision=` handling for the cohort-report PDF export routes.
 *
 * Both export surfaces (version-scoped and round-scoped) accept the same revision selector and
 * already share `renderCohortReportPdf` from this folder; the parsing lived twice, byte-identical,
 * which is exactly how the two copies would have drifted apart.
 */

import { z } from 'zod';

/** The `revision` query param: a positive revision number, `head`, or `published`. */
export const revisionParamSchema = z.string().max(20).optional();

/** Which revision to render. Anything unrecognised falls back to the working head. */
export type CohortReportRevisionSelector = number | 'head' | 'published';

/**
 * Map the raw `?revision=` value onto a selector. Deliberately lenient: an unparseable value
 * renders the head rather than erroring, because the export is a convenience surface and a bad
 * link should still produce the current report.
 */
export function resolveRevisionSelector(raw: string | undefined): CohortReportRevisionSelector {
  if (!raw || raw === 'head') return 'head';
  if (raw === 'published') return 'published';
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 'head';
}
