/**
 * Batch apply engine for design-evaluation findings (F5.4).
 *
 * The review flow is triage-then-execute: an admin works the whole run marking suggestions
 * `accepted` or `declined` — neither of which touches the questionnaire — and then presses one
 * button that executes every accepted suggestion together. This is that button's server side.
 *
 * Per-finding apply used to be the only path, and it made the reviewer decide the *order* of a
 * dozen structural edits by the order they happened to click, one confirmation at a time, with no
 * way to change their mind about the fifth after seeing the ninth. Batching turns a queue of
 * irreversible clicks into one reviewable decision.
 *
 * ## What this file does and does not do
 *
 * It is a **loop with an order and an honest report**. The actual writing is
 * {@link applyFinding} — unchanged, still re-validating every op exactly like a hand authoring
 * edit, still forking a launched version before the first write and converging every later write
 * on that same draft (`findRunReviewDraft`). Reusing it is the point: a batch must not be a second
 * apply path with its own validation, or the two drift and one of them is the one with the hole.
 *
 * Three things it adds:
 *
 *  1. **An order that does not sabotage itself** — see {@link APPLY_RANK}.
 *  2. **A live re-read between findings.** `applyFinding` takes the current structure to re-check
 *     staleness against. In a batch that structure is a moving target: the third finding must be
 *     judged against what the first two just wrote, not against what the version looked like when
 *     the button was pressed. Without this, two judges rewording the same question would both
 *     "succeed" and the second would silently overwrite the first.
 *  3. **A per-finding outcome.** Nothing is swallowed: every accepted finding comes back either
 *     applied or skipped with the reason, and the caller reports that to the reviewer. A batch that
 *     quietly drops three of eleven changes is worse than no batch.
 *
 * Deliberately NOT here: the AI leg. A finding carrying an `applyInstruction` cannot be executed by
 * a structured op alone — the reviewer's steer has to reach the wording — so those are reported as
 * `needs_ai` and left accepted rather than half-applied. Phase 3 routes them through the Structure
 * Edit Agent; until then the reviewer is told plainly which ones are waiting, which is the honest
 * state rather than a silent one.
 *
 * Route-local DB seam: uses `prisma` via `applyFinding` and one structure re-read per finding.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import type { ProposedEdit, VersionStructureInput } from '@/lib/app/questionnaire/evaluation';
import type { ScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import {
  applyFinding,
  resolveEffectiveOp,
  type ApplyAuditContext,
  type UnapplicableReason,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-apply';

/** A row the batch needs: the apply subset plus the steer and the ordering inputs. */
export interface BatchFindingRow {
  id: string;
  targetKey: string;
  proposedEdit: unknown;
  editedOverride: unknown;
  applyInstruction: string | null;
  dimension: string;
  ordinal: number;
}

/**
 * Why one accepted finding did not land. The first four are {@link UnapplicableReason} verbatim;
 * `needs_ai` is this file's own — the finding is applicable, it just cannot be executed by the
 * deterministic leg because the reviewer attached a steer that has to reach the wording.
 */
export type BatchSkipReason = UnapplicableReason | 'needs_ai';

export interface BatchAppliedItem {
  findingId: string;
  targetKey: string;
  op: ProposedEdit['op'];
}

export interface BatchSkippedItem {
  findingId: string;
  targetKey: string;
  reason: BatchSkipReason;
  detail?: string;
}

export interface BatchApplyResult {
  /** The version everything landed on — the original when it was already an editable draft. */
  versionId: string;
  versionNumber: number;
  /** A launched version was deep-copied to a new draft before the first write. */
  forked: boolean;
  applied: BatchAppliedItem[];
  skipped: BatchSkippedItem[];
}

/**
 * Execution order, least destructive first.
 *
 * The reviewer accepted a set of changes, not a sequence, so the batch has to choose one — and the
 * naive choice (the order the judges happened to emit them) loses work for no reason. Two cases
 * decide the whole ranking:
 *
 *  - **A delete must run last.** Accept "reword Q4" and "delete Q4" — a real outcome, since two
 *    judges can disagree and a reviewer can agree with both in the moment — and deleting first
 *    makes the reword `target_gone`, while rewording first makes the delete a clean no-loss. The
 *    reviewer ends up with what they asked for either way, and only one order says so without an
 *    error.
 *  - **A move must run after content edits.** `reorder` carries an absolute ordinal computed
 *    against the structure the judge saw. Content edits do not shift ordinals, but another move
 *    does, so moves cluster together at the end where they at least shift a stable base.
 *
 * Everything else is order-independent: they address different slots, or different fields of one.
 * Ties fall back to the run's own `(dimension, ordinal)`, so the same accepted set always executes
 * the same way rather than shuffling between presses.
 */
const APPLY_RANK: Record<ProposedEdit['op'], number> = {
  edit_goal: 0,
  edit_audience: 0,
  replace_prompt: 1,
  edit_guidelines: 1,
  change_type: 1,
  split_question: 2,
  add_question: 3,
  reorder: 4,
  delete_question: 5,
};

/** Unresolvable ops sort last; they are reported, not executed. */
const UNRANKED = 99;

function rankOf(row: BatchFindingRow): number {
  const op = resolveEffectiveOp(row);
  return op ? APPLY_RANK[op.op] : UNRANKED;
}

/** Stable execution order — see {@link APPLY_RANK}. Exported for the ordering test. */
export function orderForApply(rows: readonly BatchFindingRow[]): BatchFindingRow[] {
  return [...rows].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      a.dimension.localeCompare(b.dimension) ||
      a.ordinal - b.ordinal ||
      a.id.localeCompare(b.id)
  );
}

/**
 * Apply every accepted finding in one pass.
 *
 * `scoped` is the version the run belongs to. The returned `versionId` is where the writes landed:
 * the same version when it was an editable draft, a fresh fork when it was launched, or the draft
 * a previous batch from this run already created — the fork-lineage rule, enforced inside
 * `applyFinding` rather than duplicated here.
 *
 * Returns a result even when nothing applied. An empty `applied` with a populated `skipped` is a
 * real answer to "apply my accepted changes" and the caller renders it; it is not an error.
 */
export async function applyAcceptedFindings(args: {
  findings: readonly BatchFindingRow[];
  runId: string;
  questionnaireId: string;
  scoped: ScopedVersion;
  snapshot: VersionStructureInput | null;
  audit: ApplyAuditContext;
}): Promise<BatchApplyResult> {
  const { findings, runId, questionnaireId, scoped, snapshot, audit } = args;

  const applied: BatchAppliedItem[] = [];
  const skipped: BatchSkippedItem[] = [];

  // Where the writes are landing, and where staleness is judged from. Starts as the run's own
  // version and moves to the fork the moment one is made.
  let versionId = scoped.id;
  let versionNumber = scoped.versionNumber;
  let forked = false;

  for (const row of orderForApply(findings)) {
    const op = resolveEffectiveOp(row);

    // The AI leg is not built yet. Say so per finding rather than applying the judge's op and
    // discarding the reviewer's steer — an instruction silently ignored is a worse outcome than
    // one openly deferred, because the reviewer believes it was honoured.
    if (row.applyInstruction && op) {
      skipped.push({
        findingId: row.id,
        targetKey: row.targetKey,
        reason: 'needs_ai',
        detail: 'Your instructions need the AI rewrite step, which is not enabled yet.',
      });
      continue;
    }

    // Re-read between findings: the third change must be judged against what the first two wrote.
    const current = await buildEvaluationStructure(questionnaireId, versionId);
    if (!current) {
      logger.error('evaluation batch apply: structure vanished mid-batch', {
        runId,
        versionId,
        findingId: row.id,
      });
      skipped.push({ findingId: row.id, targetKey: row.targetKey, reason: 'target_gone' });
      continue;
    }

    const outcome = await applyFinding({
      finding: row,
      runId,
      scoped,
      snapshot,
      current,
      audit,
    });

    if (outcome.status === 'applied') {
      applied.push({
        findingId: row.id,
        targetKey: row.targetKey,
        // `op` is non-null on every applied outcome — `applyFinding` returns `needs_authoring`
        // without one — but the type does not know that, so name the fallback rather than assert.
        op: op ? op.op : 'replace_prompt',
      });
      versionId = outcome.appliedToVersionId;
      versionNumber = outcome.versionNumber;
      forked = forked || outcome.forked;
    } else {
      skipped.push({
        findingId: row.id,
        targetKey: row.targetKey,
        reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
    }
  }

  logAdminAction({
    userId: audit.userId,
    action: 'questionnaire_evaluation_run.batch_apply',
    entityType: 'questionnaire_evaluation_run',
    entityId: runId,
    metadata: {
      versionId,
      forked,
      appliedCount: applied.length,
      skippedCount: skipped.length,
      skippedReasons: skipped.map((s) => s.reason),
    },
    clientIp: audit.clientIp ?? null,
  });

  return { versionId, versionNumber, forked, applied, skipped };
}

/** The accepted findings of one run, in a shape {@link applyAcceptedFindings} consumes. */
export async function loadAcceptedFindings(runId: string): Promise<BatchFindingRow[]> {
  return prisma.appQuestionnaireEvaluationFinding.findMany({
    where: { runId, status: 'accepted' },
    select: {
      id: true,
      targetKey: true,
      proposedEdit: true,
      editedOverride: true,
      applyInstruction: true,
      dimension: true,
      ordinal: true,
    },
  });
}
