/**
 * Extraction-change review schemas (F2.3).
 *
 * Pure Zod — no Prisma, no Next. The list endpoint's optional filter params and
 * the persisted-status vocabulary the review surface reads. The revert endpoint
 * takes no body (the change id in the path is the whole request), so there is no
 * revert-input schema here.
 */

import { z } from 'zod';

import { CHANGE_TYPES, TARGET_ENTITY_TYPES } from '@/lib/app/questionnaire/ingestion/types';

/**
 * The persisted lifecycle of one change row. `applied` is the ingest default;
 * F2.3 flips it to `reverted`; F14.15 flips it to `superseded` when a
 * whole-structure rewrite replaced the graph the row describes. A `const` tuple
 * so the filter schema, the read view, and the UI badges share one source (same
 * discipline as the status/type tuples in the domain types module).
 *
 * Only `applied` rows are revert candidates — both `reverted` and `superseded`
 * are terminal.
 */
export const EXTRACTION_CHANGE_STATUSES = ['applied', 'reverted', 'superseded'] as const;
export type ExtractionChangeStatus = (typeof EXTRACTION_CHANGE_STATUSES)[number];

/** Optional filters for `GET …/versions/:vid/changes`. Absent = no filter. */
export const listChangesQuerySchema = z.object({
  status: z.enum(EXTRACTION_CHANGE_STATUSES).optional(),
  changeType: z.enum(CHANGE_TYPES).optional(),
  targetEntityType: z.enum(TARGET_ENTITY_TYPES).optional(),
});

export type ListChangesQuery = z.infer<typeof listChangesQuerySchema>;
