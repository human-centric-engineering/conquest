/**
 * Read-side view types for the questionnaire admin surface (P2 / F2.1a).
 *
 * The shapes the list/detail GET endpoints return and the admin UI consumes. Kept
 * **pure types, client-safe** (no Prisma, no Next, no server-only imports) so both
 * the route serializers and the `'use client'` table/detail components import the
 * same contract. Dates are serialised as ISO strings — these cross the HTTP
 * boundary, so there are no `Date` objects here.
 *
 * Distinct from `AppQuestionnaire*` Prisma rows: those carry storage detail (FKs,
 * raw JSON, `bytes`); these are the trimmed, enriched projections the UI needs.
 */

import type {
  AppQuestionnaireStatus,
  AudienceProvenance,
  AudienceShape,
  FieldProvenance,
  QuestionnaireConfigShape,
  QuestionType,
  TagColor,
} from '@/lib/app/questionnaire/types';
// DEMO-ONLY (F2.5.1): attribution summary embedded in list/detail rows.
import type { AttributedDemoClient } from '@/lib/app/questionnaire/demo-clients';
// F5.2/F5.3: design-evaluation run views reuse the judge dimension/severity/edit vocabulary.
import type {
  EvaluationDimension,
  FindingSeverity,
  FindingReviewStatus,
  FindingApplicability,
  ProposedEdit,
} from '@/lib/app/questionnaire/evaluation';

/** A vocabulary tag (F2.2) — client-safe projection of `AppQuestionTag`. */
export interface TagView {
  id: string;
  label: string;
  /** Swatch from the `TAG_COLORS` allowlist, or `null` when uncoloured. */
  color: TagColor | null;
}

/** One row in the admin questionnaires list — enriched with latest-version counts. */
export interface QuestionnaireListItem {
  id: string;
  title: string;
  status: AppQuestionnaireStatus;
  /** Total versions on this questionnaire. */
  versionCount: number;
  /** The highest-numbered version (the one the list summarises), or null if none. */
  latestVersion: {
    id: string;
    versionNumber: number;
    status: AppQuestionnaireStatus;
  } | null;
  /** Section / question / data-slot counts for the latest version (0 when no version yet). */
  sectionCount: number;
  questionCount: number;
  /** Data slots generated for the latest version (0 when none / feature unused). */
  dataSlotCount: number;
  /** DEMO-ONLY (F2.5.1): the attributed demo client, or null for a generic Sunrise demo. */
  demoClient: AttributedDemoClient | null;
  createdAt: string;
  /** Last activity — the questionnaire row's `updatedAt`. */
  updatedAt: string;
}

/** A version summary in the questionnaire detail view (no full graph). */
export interface QuestionnaireVersionSummary {
  id: string;
  versionNumber: number;
  status: AppQuestionnaireStatus;
  goal: string | null;
  audience: AudienceShape | null;
  sectionCount: number;
  questionCount: number;
  /** Data slots generated for this version (0 when none / feature unused). */
  dataSlotCount: number;
  /** Applied (not-yet-reverted) extraction-change records on this version. */
  changeCount: number;
  createdAt: string;
  updatedAt: string;
}

/** The questionnaire detail payload — the questionnaire plus its version list. */
export interface QuestionnaireDetail {
  id: string;
  title: string;
  status: AppQuestionnaireStatus;
  /** DEMO-ONLY (F2.5.1): the attributed demo client, or null for a generic Sunrise demo. */
  demoClient: AttributedDemoClient | null;
  createdAt: string;
  updatedAt: string;
  /** Versions newest-first (highest `versionNumber` first). */
  versions: QuestionnaireVersionSummary[];
}

/** A single question in the version graph. */
export interface QuestionSlotView {
  id: string;
  ordinal: number;
  key: string;
  prompt: string;
  guidelines: string | null;
  rationale: string | null;
  type: QuestionType;
  typeConfig: unknown;
  required: boolean;
  weight: number;
  extractionConfidence: number | null;
  /** Tags assigned to this question, ordered by normalised label. */
  tags: TagView[];
}

/** A section (with its questions) in the version graph. */
export interface SectionView {
  id: string;
  ordinal: number;
  title: string;
  description: string | null;
  questions: QuestionSlotView[];
}

/**
 * A version's resolved run-time configuration (F3.1) — client-safe projection of
 * `AppQuestionnaireConfig`. Always present on the graph: when no config row exists
 * the read path returns `DEFAULT_QUESTIONNAIRE_CONFIG`. Whether the admin has
 * actually saved one (which the launch gate requires) is carried by `saved`.
 */
export interface ConfigView extends QuestionnaireConfigShape {
  /** True once a config row exists for the version (admin saved at least once). */
  saved: boolean;
}

/** The full structural graph of one version — sections → questions + goal/audience. */
export interface VersionGraphView {
  id: string;
  questionnaireId: string;
  versionNumber: number;
  status: AppQuestionnaireStatus;
  goal: string | null;
  audience: AudienceShape | null;
  /**
   * Stored per-field provenance from the ingest merge. `goalProvenance` is the
   * goal's source (`null` when no goal); `audienceProvenance` has one entry per
   * resolved audience field. The UI marks a value "inferred" when its provenance
   * is `'inferred'`. Read straight from the version columns — no derivation.
   */
  goalProvenance: FieldProvenance | null;
  audienceProvenance: AudienceProvenance | null;
  sections: SectionView[];
  /** The version's tag vocabulary (F2.2), ordered by normalised label. */
  tags: TagView[];
  /** Resolved run-time configuration (F3.1) — defaults when never saved. */
  config: ConfigView;
}

/**
 * One dimension's outcome captured on a run (F5.2) — the client-safe shape of an entry
 * in the run's `dimensionSummary` JSON. `score` and `diagnostic` are mutually exclusive:
 * a judge that returned a verdict has a `score` (and `diagnostic: null`); one that failed
 * has a `diagnostic` (and `score: null`).
 */
export interface EvaluationDimensionSummary {
  dimension: EvaluationDimension;
  /** Judge score in [0, 1]; `null` when the judge failed (see `diagnostic`). */
  score: number | null;
  /** Findings this judge raised (0 when it scored cleanly or failed). */
  findingCount: number;
  /** Diagnostic code when the judge failed/was absent; `null` on success. */
  diagnostic: string | null;
}

/** One persisted finding (F5.2 + F5.3) — client-safe projection of `AppQuestionnaireEvaluationFinding`. */
export interface EvaluationFindingView {
  id: string;
  dimension: EvaluationDimension;
  /** Presentation order within (run, dimension). */
  ordinal: number;
  /** The slot `key`, `section:<title>`, `goal`, or `audience` this finding addresses. */
  targetKey: string;
  severity: FindingSeverity;
  proposedChange: string;
  rationale: string;
  sourceQuote: string | null;
  /** Review lifecycle: `pending` | `accepted` | `declined` | `applied`. */
  status: FindingReviewStatus;
  /** The judge's structured edit, when it attached one (F5.3); `null` when prose-only or degraded. */
  proposedEdit: ProposedEdit | null;
  /** The admin's edited op, which takes precedence over `proposedEdit` at apply (F5.3); `null` if unedited. */
  editedOverride: ProposedEdit | null;
  /** Admin who decided (accept/decline/edit); `null` while `pending`. */
  decidedByUserId: string | null;
  /** ISO timestamps — cross the HTTP boundary. */
  decidedAt: string | null;
  appliedAt: string | null;
  /** The version actually written when applied (may be a forked draft); `null` until applied. */
  appliedToVersionId: string | null;
  /**
   * Derived at read time (F5.3), never stored: whether intervening edits made this suggestion
   * obsolete. A stale finding's Apply is disabled — re-run the evaluation.
   */
  stale: boolean;
  /** Derived at read time (F5.3): how this finding can be actioned. See {@link FindingApplicability}. */
  applicable: FindingApplicability;
}

/** One row in the evaluation-runs list for a version (F5.2), newest-first. */
export interface EvaluationRunListItem {
  id: string;
  /** Terminal status: `completed` | `partial` | `failed`. */
  status: string;
  dimensionsRequested: number;
  dimensionsRun: number;
  dimensionsFailed: number;
  totalFindings: number;
  /** Per-dimension scores/diagnostics, in dispatch order. */
  dimensionSummary: EvaluationDimensionSummary[];
  /** Admin who ran it (`User.id`); `null` if unattributed. */
  triggeredByUserId: string | null;
  /** ISO timestamps — these cross the HTTP boundary. */
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

/** Full evaluation-run detail (F5.2) — the list row plus its findings and run context. */
export interface EvaluationRunDetail extends EvaluationRunListItem {
  versionId: string;
  questionnaireId: string;
  /** Run-level failure note when `status === 'failed'`; `null` otherwise. */
  error: string | null;
  /** All findings across dimensions, ordered by (dimension, ordinal). */
  findings: EvaluationFindingView[];
}
