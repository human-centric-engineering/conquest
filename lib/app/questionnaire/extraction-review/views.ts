/**
 * Read-side view types for the extraction-change review surface (F2.3).
 *
 * Client-safe pure types (no Prisma, no Next): the shape `GET …/versions/:vid/
 * changes` returns and the review table consumes. Dates are ISO strings — they
 * cross the HTTP boundary. Each row is enriched with a dry-run revert verdict
 * (`revertable` + `revertBlockedReason` + `revertSummary`) so the UI can disable
 * the revert button and explain *why* before the admin clicks.
 */

import type { ChangeType, TargetEntityType } from '@/lib/app/questionnaire/ingestion/types';
import type { RevertImpossibleReason } from '@/lib/app/questionnaire/extraction-review/planner';
import type { ExtractionChangeStatus } from '@/lib/app/questionnaire/extraction-review/schemas';

/** One extraction-change row, enriched for the review surface. */
export interface ExtractionChangeView {
  id: string;
  changeType: ChangeType;
  targetEntityType: TargetEntityType;
  sourceQuote: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  rationale: string | null;
  confidence: number | null;
  status: ExtractionChangeStatus;
  /** ISO timestamp of the revert, or null while applied. */
  revertedAt: string | null;
  createdAt: string;
  /** Resolved target label (section title / question key) when reconciled, else null. */
  resolvedTargetLabel: string | null;
  /** Whether this applied change can currently be reverted (dry-run planner verdict). */
  revertable: boolean;
  /** Typed reason a revert is blocked; null when revertable or already reverted. */
  revertBlockedReason: RevertImpossibleReason | null;
  /** One-line summary of the planned effect, shown in the confirm dialog. Null when blocked. */
  revertSummary: string | null;
}

/** The list payload: the version's changes (newest-first) plus status tallies. */
export interface ExtractionChangeListResponse {
  changes: ExtractionChangeView[];
  counts: { applied: number; reverted: number };
}

/** The revert response payload — the flipped row id + the applied plan summary. */
export interface RevertChangeResult {
  id: string;
  status: ExtractionChangeStatus;
  summary: string;
}
