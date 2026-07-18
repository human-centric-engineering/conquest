/**
 * Route-local persistence + read models for design-time evaluation runs (F5.2).
 *
 * The DB seam for the run route: `lib/app/questionnaire/evaluation/**` stays Prisma-free
 * (the shared `runEvaluationPanel` dispatches; this file persists and reads). Three jobs:
 *
 *   - `persistEvaluationRun` — turn a finished panel result into a run header + one finding
 *     row per judge finding, in a single transaction, deriving the terminal `status`.
 *   - `listEvaluationRuns` — newest-first page of run headers for a version (no findings).
 *   - `getEvaluationRunDetail` — one run with its findings, version-scoped (404 on mismatch).
 *
 * `dimensionSummary` is persisted as JSON and validated with a Zod schema on read (the
 * `parseAudienceShape` posture — never trust a stored JSON blob's shape), degrading a
 * malformed value to an empty array rather than throwing.
 */

import { z } from 'zod';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  EVALUATION_DIMENSIONS,
  FINDING_REVIEW_STATUSES,
  coerceProposedEdit,
  parseAudienceShape,
  versionStructureSchema,
  type EvaluationDimension,
  type ProposedEdit,
  type VersionStructureInput,
} from '@/lib/app/questionnaire/evaluation';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import type { EvaluationPanelResult } from '@/lib/app/questionnaire/evaluation/run-panel';
import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import {
  deriveApplicability,
  deriveFindingState,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-staleness';
import { resolveFindingTarget } from '@/app/api/v1/app/questionnaires/_lib/evaluation-target';
import type {
  EvaluationDimensionSummary,
  EvaluationFindingView,
  EvaluationRunDetail,
  EvaluationRunListItem,
} from '@/lib/app/questionnaire/views';

/** Terminal run status (F5.2 — no async worker, so `running`/`queued` never persist). */
export type EvaluationRunStatus = 'completed' | 'partial' | 'failed';

/** Zod shape for one `dimensionSummary` entry — validated when reading the JSON column. */
const dimensionSummarySchema = z.object({
  dimension: z.enum(EVALUATION_DIMENSIONS),
  score: z.number().min(0).max(1).nullable(),
  findingCount: z.number().int().min(0),
  diagnostic: z.string().nullable(),
});
const dimensionSummaryArraySchema = z.array(dimensionSummarySchema);

/** Derive the terminal status from the panel tallies. */
function deriveStatus(summary: EvaluationPanelResult['summary']): EvaluationRunStatus {
  if (summary.dimensionsRun === 0) return 'failed';
  if (summary.dimensionsFailed > 0) return 'partial';
  return 'completed';
}

/** Build the per-dimension summary array (one entry per requested dimension, dispatch order). */
function buildDimensionSummary(result: EvaluationPanelResult): EvaluationDimensionSummary[] {
  return result.results.map((r) => ({
    dimension: r.dimension,
    score: r.verdict ? r.verdict.score : null,
    findingCount: r.verdict ? r.verdict.findings.length : 0,
    diagnostic: r.diagnostic ?? null,
  }));
}

/** Parse a stored `dimensionSummary` JSON value, degrading a malformed blob to `[]`. */
function parseDimensionSummary(value: unknown, runId: string): EvaluationDimensionSummary[] {
  const parsed = dimensionSummaryArraySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger.warn('Malformed evaluation-run dimensionSummary; degrading to empty', { runId });
  return [];
}

/**
 * Parse a stored `structureSnapshot` into a {@link VersionStructureInput}, or `null` when absent
 * (a pre-F5.3 run) or malformed (degrade, don't throw — the `parseDimensionSummary` posture). A
 * `null` snapshot means staleness can't be derived; findings read as not-stale.
 */
export function parseStructureSnapshot(
  value: unknown,
  runId: string
): VersionStructureInput | null {
  if (value === null || value === undefined) return null;
  const parsed = versionStructureSchema.safeParse(value);
  if (parsed.success) {
    // Re-narrow the audience JSON through the dedicated parser (the schema accepts a superset).
    return { ...parsed.data, audience: parseAudienceShape(parsed.data.audience) };
  }
  logger.warn('Malformed evaluation-run structureSnapshot; staleness derivation skipped', {
    runId,
  });
  return null;
}

/** Columns for a finding row — shared by the detail read + the review-mutation seam. */
export const FINDING_SELECT = {
  id: true,
  dimension: true,
  ordinal: true,
  targetKey: true,
  severity: true,
  proposedChange: true,
  rationale: true,
  sourceQuote: true,
  proposedEdit: true,
  editedOverride: true,
  status: true,
  decidedByUserId: true,
  decidedAt: true,
  appliedAt: true,
  appliedToVersionId: true,
} as const;

/** The shape `toFindingView` consumes — a row selected with {@link FINDING_SELECT}. */
export interface FindingRow {
  id: string;
  dimension: string;
  ordinal: number;
  targetKey: string;
  severity: string;
  proposedChange: string;
  rationale: string;
  sourceQuote: string | null;
  proposedEdit: unknown;
  editedOverride: unknown;
  status: string;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  appliedAt: Date | null;
  appliedToVersionId: string | null;
}

/**
 * The effective op a finding would apply — the admin's `editedOverride` when present, else the
 * judge's `proposedEdit`. Both JSON columns are soft-validated (`coerceProposedEdit`), so a
 * malformed stored op degrades to prose-only rather than throwing.
 */
export function effectiveOp(
  row: Pick<FindingRow, 'proposedEdit' | 'editedOverride'>
): ProposedEdit | null {
  return coerceProposedEdit(row.editedOverride) ?? coerceProposedEdit(row.proposedEdit);
}

/**
 * A persisted finding row → client-safe view. `stale`/`applicable` are derived here only from
 * the op (applicability) and default `stale: false`; the detail read re-stamps `stale` against
 * the live structure for non-terminal findings (it has the structures; this row-only path does
 * not). Terminal (`applied`/`declined`) findings keep `stale: false`.
 *
 * `target` likewise defaults to `null` here and is stamped by the structure-carrying paths —
 * unlike `stale`, it is resolved for terminal findings too: an applied finding still needs to
 * say which question it was about.
 */
function toFindingView(row: FindingRow): EvaluationFindingView {
  const proposedEdit = coerceProposedEdit(row.proposedEdit);
  const editedOverride = coerceProposedEdit(row.editedOverride);
  return {
    id: row.id,
    dimension: row.dimension as EvaluationDimension,
    ordinal: row.ordinal,
    targetKey: row.targetKey,
    severity: row.severity as EvaluationFindingView['severity'],
    proposedChange: row.proposedChange,
    rationale: row.rationale,
    sourceQuote: row.sourceQuote,
    status: narrowToEnum(row.status, FINDING_REVIEW_STATUSES, 'pending'),
    proposedEdit,
    editedOverride,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    appliedToVersionId: row.appliedToVersionId,
    stale: false,
    applicable: deriveApplicability(editedOverride ?? proposedEdit),
    target: null,
  };
}

/** Export the row→view projection so the review-mutation route returns the same shape. */
export { toFindingView };

/** A persisted run header row → list-item view. */
function toRunListItem(row: {
  id: string;
  status: string;
  dimensionsRequested: number;
  dimensionsRun: number;
  dimensionsFailed: number;
  totalFindings: number;
  dimensionSummary: unknown;
  triggeredByUserId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}): EvaluationRunListItem {
  return {
    id: row.id,
    status: row.status,
    dimensionsRequested: row.dimensionsRequested,
    dimensionsRun: row.dimensionsRun,
    dimensionsFailed: row.dimensionsFailed,
    totalFindings: row.totalFindings,
    dimensionSummary: parseDimensionSummary(row.dimensionSummary, row.id),
    triggeredByUserId: row.triggeredByUserId,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Selected columns for a run header — shared by list + detail reads. */
const RUN_HEADER_SELECT = {
  id: true,
  versionId: true,
  questionnaireId: true,
  status: true,
  triggeredByUserId: true,
  dimensionsRequested: true,
  dimensionsRun: true,
  dimensionsFailed: true,
  totalFindings: true,
  dimensionSummary: true,
  error: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
} as const;

/**
 * Persist a finished panel result as a run + its findings, in one transaction, then return
 * the full detail view. `findings` are flattened from the verdicts and assigned a per-run
 * ordinal in dispatch order (so the detail reads back in a stable order).
 */
export async function persistEvaluationRun(args: {
  questionnaireId: string;
  versionId: string;
  triggeredByUserId: string;
  panel: EvaluationPanelResult;
  /** The structure the judges read — snapshotted on the run for F5.3 staleness derivation. */
  structure: VersionStructureInput;
  startedAt: Date;
  completedAt: Date;
}): Promise<EvaluationRunDetail> {
  const {
    questionnaireId,
    versionId,
    triggeredByUserId,
    panel,
    structure,
    startedAt,
    completedAt,
  } = args;
  const status = deriveStatus(panel.summary);
  const dimensionSummary = buildDimensionSummary(panel);

  // Flatten verdicts → finding rows, ordinal stable across the whole run (dispatch order). The
  // judge's optional structured `proposedEdit` is soft-validated on the way in — a malformed op
  // degrades to `null` (prose-only) rather than sinking the finding.
  let ordinal = 0;
  const findingRows = panel.results.flatMap((r) =>
    (r.verdict?.findings ?? []).map((f) => ({
      dimension: r.dimension,
      ordinal: ordinal++,
      targetKey: f.targetKey,
      severity: f.severity,
      proposedChange: f.proposedChange,
      rationale: f.rationale,
      sourceQuote: f.sourceQuote ?? null,
      proposedEdit: jsonInput(coerceProposedEdit(f.proposedEdit)),
    }))
  );

  const runId = await prisma.$transaction(async (tx) => {
    const run = await tx.appQuestionnaireEvaluationRun.create({
      data: {
        versionId,
        questionnaireId,
        status,
        triggeredByUserId,
        dimensionsRequested: panel.summary.dimensionsRequested,
        dimensionsRun: panel.summary.dimensionsRun,
        dimensionsFailed: panel.summary.dimensionsFailed,
        totalFindings: panel.summary.totalFindings,
        dimensionSummary: jsonInput(dimensionSummary),
        structureSnapshot: jsonInput(structure),
        // A run where every judge failed carries a note; partial/complete runs don't.
        error: status === 'failed' ? 'all_judges_failed' : null,
        startedAt,
        completedAt,
      },
      select: { id: true },
    });

    if (findingRows.length > 0) {
      await tx.appQuestionnaireEvaluationFinding.createMany({
        data: findingRows.map((f) => ({ ...f, runId: run.id })),
      });
    }
    return run.id;
  });

  // Re-read through the detail serializer so the POST response matches the GET-detail shape.
  const detail = await getEvaluationRunDetail(versionId, runId);
  if (!detail) {
    // The row was just written in the same request; absence here is a real fault.
    throw new Error(`Evaluation run ${runId} vanished immediately after persist`);
  }
  return detail;
}

/**
 * Newest-first page of run headers for a version. Version-scoping is the caller's job
 * (it has already resolved the version via `loadScopedVersion`); this filters by
 * `versionId` alone, which the `(versionId, createdAt)` index serves directly.
 */
export async function listEvaluationRuns(
  versionId: string,
  page: { skip: number; limit: number }
): Promise<{ runs: EvaluationRunListItem[]; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.appQuestionnaireEvaluationRun.findMany({
      where: { versionId },
      orderBy: { createdAt: 'desc' },
      skip: page.skip,
      take: page.limit,
      select: RUN_HEADER_SELECT,
    }),
    prisma.appQuestionnaireEvaluationRun.count({ where: { versionId } }),
  ]);
  return { runs: rows.map(toRunListItem), total };
}

/** A finding row plus the run context needed to apply/derive it (snapshot + scope). */
export interface ScopedFinding {
  row: FindingRow;
  versionId: string;
  questionnaireId: string;
  /** The run's structure snapshot (for staleness), already parsed; `null` if absent/malformed. */
  snapshot: VersionStructureInput | null;
}

/**
 * Load one finding scoped to (version, run): the finding must belong to `runId`, which must
 * belong to `versionId`. Returns `null` (→ 404) on any mismatch, so a finding can't be reviewed
 * across versions/runs. Carries the run's snapshot + questionnaireId for the apply/derive seam.
 */
export async function loadScopedFinding(
  versionId: string,
  runId: string,
  findingId: string
): Promise<ScopedFinding | null> {
  const row = await prisma.appQuestionnaireEvaluationFinding.findFirst({
    where: { id: findingId, runId, run: { versionId } },
    select: {
      ...FINDING_SELECT,
      run: { select: { versionId: true, questionnaireId: true, structureSnapshot: true } },
    },
  });
  if (!row) return null;
  const { run, ...findingRow } = row;
  return {
    row: findingRow,
    versionId: run.versionId,
    questionnaireId: run.questionnaireId,
    snapshot: parseStructureSnapshot(run.structureSnapshot, runId),
  };
}

/**
 * Load the live structure for staleness derivation, degrading to `null` on any error. Reading
 * findings must never fail because the structure load hiccupped — the `parseDimensionSummary`
 * posture: a derivation we can't compute simply yields not-stale.
 */
async function loadCurrentStructureSafe(questionnaireId: string, versionId: string) {
  try {
    return await buildEvaluationStructure(questionnaireId, versionId);
  } catch (err) {
    logger.warn('Evaluation staleness: live structure load failed; skipping derivation', {
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Project a {@link ScopedFinding} into its view with `stale`/`applicable` derived against the
 * live structure (the single-finding analogue of `getEvaluationRunDetail`'s per-finding pass).
 * Used by the PATCH/apply responses so they return the same shape the detail GET does.
 */
export async function buildScopedFindingView(
  scoped: ScopedFinding
): Promise<EvaluationFindingView> {
  const view = toFindingView(scoped.row);
  // The live structure is loaded even for a terminal finding: staleness is meaningless there,
  // but naming the target isn't — an applied finding must still say which question it changed.
  const current = await loadCurrentStructureSafe(scoped.questionnaireId, scoped.versionId);
  const target = resolveFindingTarget(view.targetKey, current, scoped.snapshot);
  if (!current || view.status === 'applied' || view.status === 'declined') {
    return { ...view, target };
  }
  const derived = deriveFindingState(
    { targetKey: view.targetKey, op: view.editedOverride ?? view.proposedEdit },
    scoped.snapshot,
    current
  );
  return { ...view, stale: derived.stale, applicable: derived.applicable, target };
}

/**
 * One run with its findings, scoped to the version (a run from another version returns
 * `null` → 404). Findings come back ordered by (dimension, ordinal) so the detail UI can
 * group them without re-sorting.
 */
export async function getEvaluationRunDetail(
  versionId: string,
  runId: string
): Promise<EvaluationRunDetail | null> {
  const row = await prisma.appQuestionnaireEvaluationRun.findFirst({
    where: { id: runId, versionId },
    select: {
      ...RUN_HEADER_SELECT,
      structureSnapshot: true,
      findings: {
        orderBy: [{ dimension: 'asc' }, { ordinal: 'asc' }],
        select: FINDING_SELECT,
      },
    },
  });
  if (!row) return null;

  // Derive each finding's `stale`/`applicable` against the LIVE structure (F5.3). A terminal
  // (applied/declined) finding keeps its row state — staleness is only meaningful for an open
  // suggestion. The run's `questionnaireId` scopes the live structure load.
  const snapshot = parseStructureSnapshot(row.structureSnapshot, row.id);
  const current = await loadCurrentStructureSafe(row.questionnaireId, versionId);
  const findings = row.findings.map((f) => {
    const view = toFindingView(f);
    // Resolve the target for every finding (terminal ones included — see `buildScopedFindingView`).
    const target = resolveFindingTarget(view.targetKey, current, snapshot);
    if (!current || view.status === 'applied' || view.status === 'declined') {
      return { ...view, target };
    }
    const derived = deriveFindingState(
      { targetKey: view.targetKey, op: view.editedOverride ?? view.proposedEdit },
      snapshot,
      current
    );
    return { ...view, stale: derived.stale, applicable: derived.applicable, target };
  });

  return {
    ...toRunListItem(row),
    versionId: row.versionId,
    questionnaireId: row.questionnaireId,
    error: row.error,
    findings,
  };
}
