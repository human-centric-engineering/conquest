/**
 * Apply one policy-evaluation finding to the draft version (F18.8).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/policy/evaluations/:runId/findings/:findingId/apply
 *   (no body)
 *
 *   Admin-only. Executes the finding's structured edit (`editedOverride ?? proposedEdit`) on the
 *   draft version through the fork-if-launched authoring seam, then marks the finding `applied`.
 *   Takes the apply sub-cap (apply may fork a launched version).
 *
 *   An edit that can't be applied returns **409** with a reason the UI acts on: `stale` (config
 *   drifted — re-run), `target_gone` (the target was deleted), `op_invalid`, or `needs_authoring`
 *   (prose-only — edit the Settings tab by hand). On success the response `meta` carries the fork
 *   outcome so the queue can re-point to the new draft.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { policyEvaluationApplyLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { buildPolicyEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-structure';
import {
  applyPolicyFinding,
  findRunReviewDraft,
} from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-apply';
import {
  buildScopedPolicyFindingView,
  loadScopedPolicyFinding,
} from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-run-routes';

type Params = { id: string; vid: string; runId: string; findingId: string };

const handleApply = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, runId, findingId } = await params;
  const adminId = session.user.id;

  const rl = policyEvaluationApplyLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Policy-evaluation-apply rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const scopedVersion = await loadScopedVersion(id, vid);
  if (!scopedVersion) throw new NotFoundError('Questionnaire version not found');

  const scopedFinding = await loadScopedPolicyFinding(vid, runId, findingId);
  if (!scopedFinding) throw new NotFoundError('Policy evaluation finding not found');

  if (scopedFinding.row.status === 'applied') {
    return errorResponse('Finding already applied', { code: 'CONFLICT', status: 409 });
  }

  // Build `current` against the version this apply will actually write to, NOT unconditionally
  // against `vid`: once this run's first apply has forked a launched version, every later apply
  // from the same run reuses that draft (see `findRunReviewDraft`) — `vid` itself is never
  // touched again. Reading `current` from `vid` there would compare staleness against a version
  // nothing ever edits, blinding the check to a second finding overwriting the first finding's
  // already-applied edit on the same topic/rule.
  const reuseDraft = await findRunReviewDraft(runId, scopedVersion.questionnaireId);
  const current = await buildPolicyEvaluationStructure(id, reuseDraft?.id ?? vid);
  if (!current) throw new NotFoundError('Questionnaire version not found');

  const outcome = await applyPolicyFinding({
    finding: scopedFinding.row,
    runId,
    scoped: scopedVersion,
    snapshot: scopedFinding.snapshot,
    current,
    audit: { userId: adminId, clientIp },
  });

  if (outcome.status === 'unapplicable') {
    log.info('Interviewer-policy evaluation finding not applicable', {
      versionId: vid,
      runId,
      findingId,
      reason: outcome.reason,
    });
    return errorResponse('Suggestion could not be applied', {
      code: 'CONFLICT',
      status: 409,
      details: { reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) },
    });
  }

  const updated = await loadScopedPolicyFinding(vid, runId, findingId);
  const view = updated ? await buildScopedPolicyFindingView(updated) : null;

  log.info('Interviewer-policy evaluation finding applied', {
    versionId: vid,
    runId,
    findingId,
    appliedToVersionId: outcome.appliedToVersionId,
    forked: outcome.forked,
  });

  return successResponse(
    { finding: view },
    {
      forked: outcome.forked,
      versionId: outcome.appliedToVersionId,
      versionNumber: outcome.versionNumber,
    }
  );
});

export const POST = handleApply;
