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
 * Four things it adds:
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
 *  4. **The AI leg.** A finding carrying an `applyInstruction` cannot be executed by its structured
 *     op alone — the reviewer's steer has to reach the wording — so before the loop runs, every
 *     steered finding is rewritten by {@link steerProposedEdit} and the result is fed in as an
 *     override op. The rewrite is text only: the model returns the same op's prose,
 *     `mergeSteeredEdit` rebuilds the op around it, and `applyFinding` then validates it exactly as
 *     it validates a judge's op. A steer that fails is reported and the finding stays `accepted` —
 *     never applied with the reviewer's sentence discarded, because an instruction silently ignored
 *     is a worse outcome than one openly deferred.
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
  findRunReviewDraft,
  resolveEffectiveOp,
  type ApplyAuditContext,
  type UnapplicableReason,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-apply';
import { EVALUATION_DIMENSION_SPECS } from '@/lib/app/questionnaire/evaluation/dimensions';
import { EVALUATION_DIMENSIONS } from '@/lib/app/questionnaire/evaluation/types';
import { isSteerableOp } from '@/lib/app/questionnaire/evaluation/steer-schema';
import { steerProposedEdit } from '@/lib/app/questionnaire/evaluation/steer-edit';
import type { StructureQuestion } from '@/lib/app/questionnaire/evaluation';

/** A row the batch needs: the apply subset, the steer, and the ordering + prompt inputs. */
export interface BatchFindingRow {
  id: string;
  targetKey: string;
  proposedEdit: unknown;
  editedOverride: unknown;
  applyInstruction: string | null;
  dimension: string;
  ordinal: number;
  /** The judge's prose suggestion and reasoning — context for the steer call, unused otherwise. */
  proposedChange: string;
  rationale: string;
}

/**
 * Why one accepted finding did not land.
 *
 * The first four are {@link UnapplicableReason} verbatim. The last two are this file's own, and
 * both are about the reviewer's steer:
 *
 *  - `steer_unsupported` — the instruction has nothing to act on. `delete_question`, `reorder` and
 *    `change_type` carry no wording, so there is no honest way to honour a sentence about how the
 *    change should read. Reported rather than applied-and-ignored: the reviewer typed something,
 *    and only they can decide whether to clear it or make the change by hand.
 *  - `needs_ai` — the rewrite itself did not produce a usable change (no provider, a failed call,
 *    or a model that answered about a different op). The judge's own op is NOT applied as a
 *    consolation: the reviewer asked for their version of the change, and giving them a different
 *    one under the same button is the silent-substitution failure this whole leg exists to avoid.
 */
export type BatchSkipReason = UnapplicableReason | 'needs_ai' | 'steer_unsupported';

export interface BatchAppliedItem {
  findingId: string;
  targetKey: string;
  op: ProposedEdit['op'];
  /**
   * Present only when the reviewer's instruction shaped this change: what the AI did with their
   * words, and the part of them it could not honour. `unhonoured` is the load-bearing half — a
   * steer that only partly landed has to be visible at the moment it lands, or the reviewer reads
   * "applied" as "all of it applied".
   */
  steer?: { note: string; unhonoured: string | null };
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
 *    against the structure the judge saw. Most content edits do not shift ordinals, so moves
 *    cluster at the end where they at least shift a stable base.
 *
 *    `split_question` is the exception, and it is a known rough edge rather than a claim to the
 *    contrary: its write increments the ordinal of every later question in the section. So an
 *    accepted `reorder` for a question after an accepted split in the same section is judged stale
 *    and skipped — safely (nothing is lost, and it stays accepted) but with a reason that misleads:
 *    the reviewer is told "the question changed since this evaluation ran" when it was this batch
 *    that changed it. Rewording the reason, or re-deriving reorder ordinals after a split, is the
 *    fix; neither belongs in an ordering constant.
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

/* -------------------------------------------------------------------------- */
/* The AI leg — the reviewer's steer, resolved before anything is written      */
/* -------------------------------------------------------------------------- */

/**
 * How many steer calls run at once.
 *
 * The steers are independent of one another — each rewrites one change's wording — so they are not
 * run in the apply loop's order, and not one at a time: a reviewer who steered eight findings would
 * otherwise wait out eight sequential model calls with nothing on screen. Four at a time is a
 * deliberate middle: it keeps a realistic batch inside one request's wall-clock without opening a
 * burst of provider calls wide enough to trip an upstream rate limit and fail steers that would
 * otherwise have succeeded.
 */
const STEER_CONCURRENCY = 4;

/** What the pre-pass decided about one steered finding. */
type SteerDecision =
  | { kind: 'edit'; edit: ProposedEdit; note: string; unhonoured: string | null }
  | { kind: 'skip'; reason: BatchSkipReason; detail: string };

/** Find the question a finding is about in the current structure — `null` for a version-level op. */
function findQuestion(
  structure: VersionStructureInput,
  targetKey: string
): StructureQuestion | null {
  for (const section of structure.sections) {
    const match = section.questions.find((q) => q.key === targetKey);
    if (match) return match;
  }
  return null;
}

/**
 * The judge's display label, so the steer prompt reads as a person rather than an enum key.
 *
 * `dimension` is a plain `String` column, so it is narrowed by membership rather than asserted:
 * a cast would tell the type system the lookup always hits while the value came from a row that
 * could hold anything, leaving a runtime `undefined` behind a type that says otherwise.
 */
function dimensionLabel(dimension: string): string {
  const known = EVALUATION_DIMENSIONS.find((d) => d === dimension);
  return known ? EVALUATION_DIMENSION_SPECS[known].label : 'evaluation';
}

/**
 * Rewrite every steered finding, before a single write happens.
 *
 * Up front rather than inside the loop, for two reasons. The apply loop re-reads the structure
 * between findings because each write moves the target the next one is judged against; a steer has
 * no such dependency — it rewrites the wording of a change against the questionnaire as the
 * reviewer saw it, which is the same thing the judge proposed it against. And doing them together
 * means the calls can overlap, which is the difference between a batch that returns and one that
 * times out.
 *
 * Every failure is a decision too. Nothing here throws: a steer that could not be produced becomes
 * a `skip` the loop reports, so one dead provider call cannot take the other ten changes down with
 * it.
 */
async function resolveSteers(args: {
  findings: readonly BatchFindingRow[];
  /** `null` when the version's structure could not be read — every steer is then reported, not run. */
  structure: VersionStructureInput | null;
  runId: string;
  versionId: string;
  userId: string;
}): Promise<Map<string, SteerDecision>> {
  const { findings, structure, runId, versionId, userId } = args;
  const decisions = new Map<string, SteerDecision>();

  const queue: { row: BatchFindingRow; op: ProposedEdit }[] = [];
  for (const row of findings) {
    if (!row.applyInstruction) continue;

    // No structure to read means the version went out from under the batch. Report the steer
    // rather than calling a model about a questionnaire nobody can see; the loop's own re-read
    // then reports the rest of the run for what it is.
    if (!structure) {
      decisions.set(row.id, {
        kind: 'skip',
        reason: 'needs_ai',
        detail: 'The questionnaire could not be read to make this change.',
      });
      continue;
    }

    const op = resolveEffectiveOp(row);
    // No op at all is `needs_authoring`, which the loop reports on its own — an instruction on a
    // prose-only finding is not a steer failure, it is a finding with nothing to steer.
    if (!op) continue;
    if (!isSteerableOp(op)) {
      decisions.set(row.id, {
        kind: 'skip',
        reason: 'steer_unsupported',
        detail: 'This change has no wording for an instruction to shape.',
      });
      continue;
    }
    queue.push({ row, op });
  }

  if (queue.length === 0) return decisions;

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= queue.length) return;
      const { row, op } = queue[index];
      const outcome = await steerProposedEdit(
        {
          // `applyInstruction` is non-null for everything queued above; the type cannot see it.
          instruction: row.applyInstruction ?? '',
          op,
          proposedChange: row.proposedChange,
          rationale: row.rationale,
          dimensionLabel: dimensionLabel(row.dimension),
          // Non-null for anything queued: a null structure short-circuits above.
          question: structure ? findQuestion(structure, row.targetKey) : null,
          goal: structure?.goal ?? null,
          audience: structure?.audience ?? null,
        },
        { versionId, runId, findingId: row.id, userId }
      );
      decisions.set(
        row.id,
        outcome.ok
          ? { kind: 'edit', edit: outcome.edit, note: outcome.note, unhonoured: outcome.unhonoured }
          : { kind: 'skip', reason: 'needs_ai', detail: outcome.message }
      );
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(STEER_CONCURRENCY, queue.length) }, () => worker())
  );

  return decisions;
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

  // Where the writes are landing, and where staleness is judged from.
  //
  // It starts at the draft this run is ALREADY editing, not at the run's own version. `applyFinding`
  // resolves its write target the same way (the F5.3 fork-lineage rule), so a batch that began from
  // `scoped.id` would judge every finding up to its first successful write against a version it was
  // not editing. That is not academic: press Apply, then press it again — which the half-triaged
  // confirmation explicitly invites — and the second batch's first finding is compared against the
  // untouched original, reads as not-stale, and silently overwrites what the first batch wrote.
  const openingDraft = await findRunReviewDraft(runId, scoped.questionnaireId);
  let versionId = openingDraft?.id ?? scoped.id;
  let versionNumber = openingDraft?.versionNumber ?? scoped.versionNumber;
  let forked = false;

  // The AI leg, resolved in one overlapping pass before anything is written — see
  // {@link resolveSteers}. A run where nobody typed an instruction never reads the structure here
  // and never reaches a provider: the deterministic path stays exactly as cheap as it was.
  const steers = findings.some((f) => f.applyInstruction)
    ? await resolveSteers({
        findings,
        structure: await buildEvaluationStructure(questionnaireId, versionId),
        runId,
        // The version the steers are worded against — the draft when this run already made one, or
        // the rewrite reasons about a questionnaire the change will not land on.
        versionId,
        userId: audit.userId,
      })
    : new Map<string, SteerDecision>();

  for (const row of orderForApply(findings)) {
    const steer = steers.get(row.id);

    // A steer that could not be produced stops this change and nothing else. The judge's own op is
    // deliberately NOT applied instead: the reviewer asked for their version of it, and quietly
    // giving them a different one under the same button is the substitution this leg exists to
    // avoid. The finding stays accepted, so fixing the cause and applying again picks it up.
    if (steer?.kind === 'skip') {
      skipped.push({
        findingId: row.id,
        targetKey: row.targetKey,
        reason: steer.reason,
        detail: steer.detail,
      });
      continue;
    }

    // The steered op rides in as an override, so the write path is the one that already validates
    // an admin's typed override — the AI leg adds a rewriter in front of apply, not a way past it.
    const applyRow: BatchFindingRow =
      steer?.kind === 'edit' ? { ...row, editedOverride: steer.edit } : row;
    const op = resolveEffectiveOp(applyRow);

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
      finding: applyRow,
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
        ...(steer?.kind === 'edit'
          ? { steer: { note: steer.note, unhonoured: steer.unhonoured } }
          : {}),
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
      steeredCount: applied.filter((a) => a.steer).length,
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
      proposedChange: true,
      rationale: true,
    },
  });
}
