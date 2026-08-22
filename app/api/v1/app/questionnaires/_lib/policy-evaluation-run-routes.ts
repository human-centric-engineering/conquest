/**
 * Route-local persistence + read models for policy-evaluation runs (F18.8).
 *
 * The DB seam for the run route: `lib/app/questionnaire/policy-evaluation/**` stays Prisma-free
 * (`runPolicyEvaluationPanel` dispatches; this file persists and reads). Mirrors
 * `scope-evaluation-run-routes.ts` exactly, minus cross-judge reconciliation (this panel has none
 * — and for different reasons than the scope panel; see `run-panel.ts`'s module doc):
 *
 *   - `persistPolicyEvaluationRun` — turn a finished panel result into a run header + one finding
 *     row per judge finding, in a single transaction, deriving the terminal `status`.
 *   - `listPolicyEvaluationRuns` — newest-first page of run headers for a version.
 *   - `getPolicyEvaluationRunDetail` — one run with its findings, version-scoped (404 on mismatch).
 *   - `loadLatestPolicyEvaluationRun` — the newest run with its findings, for callers (the
 *     Questionnaire Pack export) that want "the current state of the panel."
 *   - `loadRunForPolicyJudgeRetry` / `mergePolicyJudgeRetry` — re-run one failed judge into the
 *     existing run rather than spawning a second one.
 */

import { z } from 'zod';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  POLICY_EVALUATION_DIMENSIONS,
  coercePolicyProposedEdit,
  policyStructureSchema,
  type PolicyEvaluationDimension,
  type PolicyJudgeVerdict,
  type PolicyProposedEdit,
  type PolicyStructureInput,
} from '@/lib/app/questionnaire/policy-evaluation';
// Generic vocab shared with the design-evaluation panel — not re-declared per module doc.
import { FINDING_REVIEW_STATUSES } from '@/lib/app/questionnaire/evaluation/types';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import type {
  PolicyDimensionResult,
  PolicyEvaluationPanelResult,
} from '@/lib/app/questionnaire/policy-evaluation/run-panel';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { buildPolicyEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-structure';
import {
  derivePolicyApplicability,
  derivePolicyFindingState,
} from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-staleness';
import { resolvePolicyFindingTarget } from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-target';
import type {
  PolicyEvaluationDimensionSummary,
  PolicyEvaluationFindingView,
  PolicyEvaluationRunDetail,
  PolicyEvaluationRunListItem,
} from '@/lib/app/questionnaire/views';

/** Terminal run status (same three as the design-evaluation panel — no async worker). */
export type PolicyEvaluationRunStatus = 'completed' | 'partial' | 'failed';

/** Zod shape for one `dimensionSummary` entry — validated when reading the JSON column. */
const dimensionSummarySchema = z.object({
  dimension: z.enum(POLICY_EVALUATION_DIMENSIONS),
  score: z.number().min(0).max(1).nullable(),
  findingCount: z.number().int().min(0),
  diagnostic: z.string().nullable(),
});
const dimensionSummaryArraySchema = z.array(dimensionSummarySchema);

/** Shared by the initial persist and the single-judge retry, so status is derived consistently. */
function statusFromCounts(
  dimensionsRun: number,
  dimensionsFailed: number
): PolicyEvaluationRunStatus {
  if (dimensionsRun === 0) return 'failed';
  if (dimensionsFailed > 0) return 'partial';
  return 'completed';
}

function deriveStatus(summary: PolicyEvaluationPanelResult['summary']): PolicyEvaluationRunStatus {
  return statusFromCounts(summary.dimensionsRun, summary.dimensionsFailed);
}

/** One judge finding → a `createMany` row. Shared by the initial persist and the judge retry. */
function findingRowData(
  dimension: PolicyEvaluationDimension,
  finding: PolicyJudgeVerdict['findings'][number],
  ordinal: number
) {
  return {
    dimension,
    ordinal,
    targetKey: finding.targetKey,
    severity: finding.severity,
    proposedChange: finding.proposedChange,
    rationale: finding.rationale,
    sourceQuote: finding.sourceQuote ?? null,
    proposedEdit: jsonInput(coercePolicyProposedEdit(finding.proposedEdit)),
  };
}

/** Build the per-dimension summary array (one entry per requested dimension, dispatch order). */
function buildDimensionSummary(
  result: PolicyEvaluationPanelResult
): PolicyEvaluationDimensionSummary[] {
  return result.results.map((r) => ({
    dimension: r.dimension,
    score: r.verdict ? r.verdict.score : null,
    findingCount: r.verdict ? r.verdict.findings.length : 0,
    diagnostic: r.diagnostic ?? null,
  }));
}

/** Parse a stored `dimensionSummary` JSON value, degrading a malformed blob to `[]`. */
function parseDimensionSummary(value: unknown, runId: string): PolicyEvaluationDimensionSummary[] {
  const parsed = dimensionSummaryArraySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger.warn('Malformed policy-evaluation-run dimensionSummary; degrading to empty', { runId });
  return [];
}

/**
 * Parse a stored `policySnapshot` into a {@link PolicyStructureInput}, or `null` when absent or
 * malformed — degrade, don't throw. A `null` snapshot means staleness can't be derived; findings
 * read as not-stale.
 */
export function parsePolicyStructureSnapshot(
  value: unknown,
  runId: string
): PolicyStructureInput | null {
  if (value === null || value === undefined) return null;
  const parsed = policyStructureSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger.warn('Malformed policy-evaluation-run policySnapshot; staleness derivation skipped', {
    runId,
  });
  return null;
}

/** Columns for a finding row — shared by the detail read + the review-mutation seam. */
export const POLICY_FINDING_SELECT = {
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

/** The shape `toFindingView` consumes — a row selected with {@link POLICY_FINDING_SELECT}. */
export interface PolicyFindingRow {
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

/** The effective op a finding would apply — the admin's `editedOverride` when present, else the judge's. */
export function policyEffectiveOp(
  row: Pick<PolicyFindingRow, 'proposedEdit' | 'editedOverride'>
): PolicyProposedEdit | null {
  return coercePolicyProposedEdit(row.editedOverride) ?? coercePolicyProposedEdit(row.proposedEdit);
}

/** A persisted finding row → client-safe view (target/stale left for the structure-carrying paths). */
function toFindingView(row: PolicyFindingRow): PolicyEvaluationFindingView {
  const proposedEdit = coercePolicyProposedEdit(row.proposedEdit);
  const editedOverride = coercePolicyProposedEdit(row.editedOverride);
  return {
    id: row.id,
    dimension: row.dimension as PolicyEvaluationDimension,
    ordinal: row.ordinal,
    targetKey: row.targetKey,
    severity: row.severity as PolicyEvaluationFindingView['severity'],
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
    applicable: derivePolicyApplicability(editedOverride ?? proposedEdit),
    target: null,
  };
}

export { toFindingView as toPolicyFindingView };

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
}): PolicyEvaluationRunListItem {
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
 * Persist a finished panel result as a run + its findings, in one transaction, then return the
 * full detail view.
 */
export async function persistPolicyEvaluationRun(args: {
  questionnaireId: string;
  versionId: string;
  triggeredByUserId: string;
  panel: PolicyEvaluationPanelResult;
  /** The policy config the judges read — snapshotted on the run for staleness derivation. */
  structure: PolicyStructureInput;
  startedAt: Date;
  completedAt: Date;
}): Promise<PolicyEvaluationRunDetail> {
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

  let ordinal = 0;
  const findingRows = panel.results.flatMap((r) =>
    (r.verdict?.findings ?? []).map((f) => findingRowData(r.dimension, f, ordinal++))
  );

  const runId = await prisma.$transaction(async (tx) => {
    const run = await tx.appQuestionnairePolicyEvaluationRun.create({
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
        policySnapshot: jsonInput(structure),
        error: status === 'failed' ? 'all_judges_failed' : null,
        startedAt,
        completedAt,
      },
      select: { id: true },
    });

    if (findingRows.length > 0) {
      await tx.appQuestionnairePolicyEvaluationFinding.createMany({
        data: findingRows.map((f) => ({ ...f, runId: run.id })),
      });
    }
    return run.id;
  });

  const detail = await getPolicyEvaluationRunDetail(versionId, runId);
  if (!detail) {
    throw new Error(`Policy-evaluation run ${runId} vanished immediately after persist`);
  }
  return detail;
}

/** Newest-first page of run headers for a version. */
export async function listPolicyEvaluationRuns(
  versionId: string,
  page: { skip: number; limit: number }
): Promise<{ runs: PolicyEvaluationRunListItem[]; total: number }> {
  const [rows, total] = await Promise.all([
    prisma.appQuestionnairePolicyEvaluationRun.findMany({
      where: { versionId },
      orderBy: { createdAt: 'desc' },
      skip: page.skip,
      take: page.limit,
      select: RUN_HEADER_SELECT,
    }),
    prisma.appQuestionnairePolicyEvaluationRun.count({ where: { versionId } }),
  ]);
  return { runs: rows.map(toRunListItem), total };
}

/**
 * The version's most recently started policy-evaluation run, with its findings — for consumers
 * outside the admin UI (the Questionnaire Pack export) that want "the current state of the
 * panel" without paging the run list. `null` when the version has never been evaluated.
 */
export async function loadLatestPolicyEvaluationRun(
  versionId: string
): Promise<PolicyEvaluationRunDetail | null> {
  const { runs } = await listPolicyEvaluationRuns(versionId, { skip: 0, limit: 1 });
  const latest = runs[0];
  if (!latest) return null;
  return getPolicyEvaluationRunDetail(versionId, latest.id);
}

/** A finding row plus the run context needed to apply/derive it (snapshot + version scope). */
export interface ScopedPolicyFinding {
  row: PolicyFindingRow;
  versionId: string;
  questionnaireId: string;
  snapshot: PolicyStructureInput | null;
}

/**
 * Load one finding scoped to (version, run): the finding must belong to `runId`, which must
 * belong to `versionId`. Returns `null` (→ 404) on any mismatch.
 */
export async function loadScopedPolicyFinding(
  versionId: string,
  runId: string,
  findingId: string
): Promise<ScopedPolicyFinding | null> {
  const row = await prisma.appQuestionnairePolicyEvaluationFinding.findFirst({
    where: { id: findingId, runId, run: { versionId } },
    select: {
      ...POLICY_FINDING_SELECT,
      run: { select: { versionId: true, questionnaireId: true, policySnapshot: true } },
    },
  });
  if (!row) return null;
  const { run, ...findingRow } = row;
  return {
    row: findingRow,
    versionId: run.versionId,
    questionnaireId: run.questionnaireId,
    snapshot: parsePolicyStructureSnapshot(run.policySnapshot, runId),
  };
}

/** Load the live policy config for staleness derivation, degrading to `null` on any error. */
async function loadCurrentStructureSafe(
  questionnaireId: string,
  versionId: string
): Promise<PolicyStructureInput | null> {
  try {
    return await buildPolicyEvaluationStructure(questionnaireId, versionId);
  } catch (err) {
    logger.warn('Policy-evaluation staleness: live structure load failed; skipping derivation', {
      versionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Project a {@link ScopedPolicyFinding} into its view with `stale`/`applicable` derived against
 * the live config — used by the PATCH/apply responses.
 */
export async function buildScopedPolicyFindingView(
  scoped: ScopedPolicyFinding
): Promise<PolicyEvaluationFindingView> {
  const view = toFindingView(scoped.row);
  const current = await loadCurrentStructureSafe(scoped.questionnaireId, scoped.versionId);
  const target = resolvePolicyFindingTarget(view.targetKey, current, scoped.snapshot);
  if (!current || view.status === 'applied' || view.status === 'declined') {
    return { ...view, target };
  }
  const derived = derivePolicyFindingState(
    { targetKey: view.targetKey, op: view.editedOverride ?? view.proposedEdit },
    scoped.snapshot,
    current
  );
  return { ...view, stale: derived.stale, applicable: derived.applicable, target };
}

/** One run with its findings, scoped to the version (a run from another version returns `null`). */
export async function getPolicyEvaluationRunDetail(
  versionId: string,
  runId: string
): Promise<PolicyEvaluationRunDetail | null> {
  const row = await prisma.appQuestionnairePolicyEvaluationRun.findFirst({
    where: { id: runId, versionId },
    select: {
      ...RUN_HEADER_SELECT,
      policySnapshot: true,
      findings: {
        orderBy: [{ dimension: 'asc' }, { ordinal: 'asc' }],
        select: POLICY_FINDING_SELECT,
      },
    },
  });
  if (!row) return null;

  const snapshot = parsePolicyStructureSnapshot(row.policySnapshot, row.id);
  const current = await loadCurrentStructureSafe(row.questionnaireId, versionId);
  const findings = row.findings.map((f) => {
    const view = toFindingView(f);
    const target = resolvePolicyFindingTarget(view.targetKey, current, snapshot);
    if (!current || view.status === 'applied' || view.status === 'declined') {
      return { ...view, target };
    }
    const derived = derivePolicyFindingState(
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

/** A run loaded for a single-judge retry: its version scope, and the config the judges read. */
export interface RetryablePolicyRun {
  id: string;
  versionId: string;
  questionnaireId: string;
  summary: PolicyEvaluationDimensionSummary[];
  snapshot: PolicyStructureInput | null;
}

/** Load one run for a judge retry, scoped to the version. */
export async function loadRunForPolicyJudgeRetry(
  versionId: string,
  runId: string
): Promise<RetryablePolicyRun | null> {
  const row = await prisma.appQuestionnairePolicyEvaluationRun.findFirst({
    where: { id: runId, versionId },
    select: {
      id: true,
      versionId: true,
      questionnaireId: true,
      dimensionSummary: true,
      policySnapshot: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    versionId: row.versionId,
    questionnaireId: row.questionnaireId,
    summary: parseDimensionSummary(row.dimensionSummary, row.id),
    snapshot: parsePolicyStructureSnapshot(row.policySnapshot, row.id),
  };
}

/**
 * Fold one judge's re-dispatch back into the run it belongs to — mirrors `mergeJudgeRetry`'s
 * locking discipline (`FOR UPDATE` on the run row) so two concurrent retries of two different
 * failed judges on the same run can't clobber each other's summary patch.
 */
export async function mergePolicyJudgeRetry(args: {
  run: RetryablePolicyRun;
  result: PolicyDimensionResult;
  completedAt: Date;
}): Promise<PolicyEvaluationRunDetail> {
  const { run, result, completedAt } = args;
  const findings = result.verdict?.findings ?? [];

  const patched: PolicyEvaluationDimensionSummary = {
    dimension: result.dimension,
    score: result.verdict ? result.verdict.score : null,
    findingCount: findings.length,
    diagnostic: result.diagnostic ?? null,
  };

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "app_questionnaire_policy_evaluation_run" WHERE id = ${run.id} FOR UPDATE`;

    const current = await tx.appQuestionnairePolicyEvaluationRun.findUnique({
      where: { id: run.id },
      select: { dimensionSummary: true },
    });
    const base = current ? parseDimensionSummary(current.dimensionSummary, run.id) : run.summary;
    const summary = base.map((d) => (d.dimension === result.dimension ? patched : d));

    const dimensionsFailed = summary.filter((d) => d.diagnostic !== null).length;
    const dimensionsRun = summary.length - dimensionsFailed;
    const status = statusFromCounts(dimensionsRun, dimensionsFailed);

    await tx.appQuestionnairePolicyEvaluationFinding.deleteMany({
      where: { runId: run.id, dimension: result.dimension },
    });

    if (findings.length > 0) {
      const highest = await tx.appQuestionnairePolicyEvaluationFinding.aggregate({
        where: { runId: run.id },
        _max: { ordinal: true },
      });
      let ordinal = (highest._max.ordinal ?? -1) + 1;
      await tx.appQuestionnairePolicyEvaluationFinding.createMany({
        data: findings.map((f) => ({
          ...findingRowData(result.dimension, f, ordinal++),
          runId: run.id,
        })),
      });
    }

    const totalFindings = await tx.appQuestionnairePolicyEvaluationFinding.count({
      where: { runId: run.id },
    });

    await tx.appQuestionnairePolicyEvaluationRun.update({
      where: { id: run.id },
      data: {
        status,
        dimensionsRun,
        dimensionsFailed,
        totalFindings,
        dimensionSummary: jsonInput(summary),
        error: status === 'failed' ? 'all_judges_failed' : null,
        completedAt,
      },
    });
  });

  const detail = await getPolicyEvaluationRunDetail(run.versionId, run.id);
  if (!detail) {
    throw new Error(`Policy-evaluation run ${run.id} vanished immediately after a judge retry`);
  }
  return detail;
}
