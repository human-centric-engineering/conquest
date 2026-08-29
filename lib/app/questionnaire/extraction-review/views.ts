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
import type { VersionFidelityView } from '@/lib/app/questionnaire/ingestion/fidelity-detail';

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
  /** ISO timestamp of the supersede (whole-structure rewrite), or null otherwise. */
  supersededAt: string | null;
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
  counts: { applied: number; reverted: number; superseded: number };
  /**
   * What the fidelity critic concluded about this extraction, when a verify pass ran for the
   * version. Null when none did (a composed questionnaire, an older version, a failed dispatch).
   *
   * It rides this payload rather than an endpoint of its own because it belongs to the same
   * question the table answers — "what did the extractor do to my document?" — and two of its
   * three signals are specifically about edits MISSING from that table. Costs one indexed query
   * in a `Promise.all` that already runs three.
   */
  fidelity: VersionFidelityView | null;
}

/** The revert response payload — the flipped row id + the applied plan summary. */
export interface RevertChangeResult {
  id: string;
  status: ExtractionChangeStatus;
  summary: string;
}
