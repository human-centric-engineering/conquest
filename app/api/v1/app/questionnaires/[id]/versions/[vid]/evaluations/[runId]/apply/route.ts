/**
 * Apply every accepted finding of one design-evaluation run, as a batch (F5.4).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/evaluations/:runId/apply
 *   (no body)
 *
 *   Admin-only. Executes the accepted suggestions together, in an order chosen so they do not
 *   sabotage each other, and reports what landed and what did not. Takes the apply sub-cap: one
 *   call may fork a launched version (a multi-row deep copy) and then write many edits.
 *
 *   This is the ONLY way a design-evaluation suggestion reaches the questionnaire from the UI.
 *   Reviewing (`accept` / `decline` on the finding PATCH) writes nothing structural, so an admin
 *   triages the whole run first and then executes it in one reviewable decision. The per-finding
 *   `…/findings/:findingId/apply` POST still exists for API callers who want one at a time.
 *
 *   Findings carrying the reviewer's `applyInstruction` take the AI leg first: one structured
 *   completion each, run concurrently before any write, rewriting that change's wording to follow
 *   the instruction. `applied[].steer` reports what the AI did with the reviewer's words, including
 *   the part of them it could not honour.
 *
 *   **The rate limit is not a spend limit.** `evaluationApplyLimiter` was sized (60/min) for fork
 *   churn on an apply that made no model calls, and it still is; one steered batch can now issue a
 *   completion per accepted finding, so the cap bounds requests and not provider calls. The steer
 *   agent's `monthlyBudgetUsd` is recorded against it by `logCost` but is not checked before a call.
 *   An admin steering an entire large run is therefore bounded by nothing tighter than the run's own
 *   finding count — worth a per-batch steer cap if that turns out to matter in practice.
 *
 *   **Always 200 when the run resolves**, even when nothing applied. "Every accepted change was
 *   already stale" is an answer, not a failure, and the reviewer needs the per-finding reasons to
 *   act on it — an error envelope would throw those away. The response carries:
 *
 *     data.versionId / versionNumber / forked  — where the writes landed
 *     data.applied[]                           — { findingId, targetKey, op, steer? }
 *     data.skipped[]                           — { findingId, targetKey, reason, detail? }
 *     data.findings[]                          — every finding, re-derived, so the queue updates
 *                                                in place without a second round trip
 *
 *   404 when the questionnaire version or the run does not resolve.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { evaluationApplyLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  getEvaluationRunDetail,
  parseStructureSnapshot,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';
import {
  applyAcceptedFindings,
  loadAcceptedFindings,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-batch-apply';

type Params = { id: string; vid: string; runId: string };

const handleBatchApply = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, runId } = await params;
  const adminId = session.user.id;

  const rl = evaluationApplyLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Evaluation batch-apply rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const scopedVersion = await loadScopedVersion(id, vid);
  if (!scopedVersion) throw new NotFoundError('Questionnaire version not found');

  const run = await prisma.appQuestionnaireEvaluationRun.findFirst({
    where: { id: runId, versionId: vid },
    select: { id: true, structureSnapshot: true },
  });
  if (!run) throw new NotFoundError('Evaluation run not found');

  const snapshot = parseStructureSnapshot(run.structureSnapshot, run.id);
  const findings = await loadAcceptedFindings(runId);

  const result = await applyAcceptedFindings({
    findings,
    runId,
    questionnaireId: id,
    scoped: scopedVersion,
    snapshot,
    audit: { userId: adminId, clientIp },
  });

  // Re-derive the whole run so the queue re-renders from one response, with applied findings now
  // terminal.
  //
  // Note what this canNOT refresh: staleness is derived against `vid`, and when the batch forked,
  // the writes landed on a new draft that `vid` knows nothing about. So a finding the batch skipped
  // as stale still reads `stale: false` here. The free-text skip list is what explains those, which
  // is the reason it is rendered rather than being a debug detail.
  const detail = await getEvaluationRunDetail(vid, runId);

  log.info('Questionnaire design-evaluation run batch-applied', {
    versionId: vid,
    runId,
    appliedToVersionId: result.versionId,
    forked: result.forked,
    applied: result.applied.length,
    skipped: result.skipped.length,
    steered: result.applied.filter((a) => a.steer).length,
  });

  return successResponse(
    {
      versionId: result.versionId,
      versionNumber: result.versionNumber,
      forked: result.forked,
      applied: result.applied,
      skipped: result.skipped,
      findings: detail?.findings ?? [],
    },
    {
      forked: result.forked,
      versionId: result.versionId,
      versionNumber: result.versionNumber,
    }
  );
});

export const POST = handleBatchApply;

/**
 * Serverless ceiling, in seconds. Present because F5.4's AI leg turned this into an LLM route.
 *
 * A steered batch runs one structured completion per steered finding, four at a time, and
 * `runStructuredCompletion` gives its retry a *fresh* `STEER_TIMEOUT_MS` — so a dozen steers can
 * legitimately take minutes before the write loop starts. On the platform default this route gets
 * killed mid-loop, and that failure is worse than a slow one: some findings are already stamped
 * `applied` in their own transactions, while the per-finding report — the only place a change that
 * did NOT land is ever named — never reaches the reviewer at all.
 *
 * 300 matches every other LLM-calling questionnaire route (the evaluation panel, preview, report).
 */
export const maxDuration = 300;
