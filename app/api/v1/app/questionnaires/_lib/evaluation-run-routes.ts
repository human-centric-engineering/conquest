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
  type EvaluationDimension,
} from '@/lib/app/questionnaire/evaluation';
import type { EvaluationPanelResult } from '@/lib/app/questionnaire/evaluation/run-panel';
import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
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

/** A persisted finding row → client-safe view. */
function toFindingView(row: {
  id: string;
  dimension: string;
  ordinal: number;
  targetKey: string;
  severity: string;
  proposedChange: string;
  rationale: string;
  sourceQuote: string | null;
  status: string;
}): EvaluationFindingView {
  return {
    id: row.id,
    dimension: row.dimension as EvaluationDimension,
    ordinal: row.ordinal,
    targetKey: row.targetKey,
    severity: row.severity as EvaluationFindingView['severity'],
    proposedChange: row.proposedChange,
    rationale: row.rationale,
    sourceQuote: row.sourceQuote,
    status: row.status,
  };
}

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
  startedAt: Date;
  completedAt: Date;
}): Promise<EvaluationRunDetail> {
  const { questionnaireId, versionId, triggeredByUserId, panel, startedAt, completedAt } = args;
  const status = deriveStatus(panel.summary);
  const dimensionSummary = buildDimensionSummary(panel);

  // Flatten verdicts → finding rows, ordinal stable across the whole run (dispatch order).
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
      findings: {
        orderBy: [{ dimension: 'asc' }, { ordinal: 'asc' }],
        select: {
          id: true,
          dimension: true,
          ordinal: true,
          targetKey: true,
          severity: true,
          proposedChange: true,
          rationale: true,
          sourceQuote: true,
          status: true,
        },
      },
    },
  });
  if (!row) return null;

  return {
    ...toRunListItem(row),
    versionId: row.versionId,
    questionnaireId: row.questionnaireId,
    error: row.error,
    findings: row.findings.map(toFindingView),
  };
}
