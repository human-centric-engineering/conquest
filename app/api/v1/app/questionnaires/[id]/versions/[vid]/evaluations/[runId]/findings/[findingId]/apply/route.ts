/**
 * Apply one design-evaluation finding to the draft version (F5.3).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/evaluations/:runId/findings/:findingId/apply
 *   (no body)
 *
 *   Admin-only. Executes the finding's structured edit (`editedOverride ?? proposedEdit`) on the
 *   draft version through the fork-if-launched authoring seam, then marks the finding `applied`.
 *   Takes the apply sub-cap (apply may fork a launched version — a multi-row deep copy).
 *
 *   An edit that can't be applied returns **409** with a reason the UI acts on:
 *   `stale` (structure drifted — re-run), `target_gone` (the target was deleted),
 *   `op_invalid` (e.g. an incompatible type config), or `needs_authoring` (prose-only or an
 *   `add_question` draft — open the editor). On success the response `meta` carries the fork
 *   outcome so the queue can re-point `?v=` to the new draft.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { evaluationApplyLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import { applyFinding } from '@/app/api/v1/app/questionnaires/_lib/evaluation-apply';
import {
  buildScopedFindingView,
  loadScopedFinding,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';

type Params = { id: string; vid: string; runId: string; findingId: string };

const handleApply = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, runId, findingId } = await params;
  const adminId = session.user.id;

  const rl = evaluationApplyLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Evaluation-apply rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const scopedVersion = await loadScopedVersion(id, vid);
  if (!scopedVersion) throw new NotFoundError('Questionnaire version not found');

  const scopedFinding = await loadScopedFinding(vid, runId, findingId);
  if (!scopedFinding) throw new NotFoundError('Evaluation finding not found');

  if (scopedFinding.row.status === 'applied') {
    return errorResponse('Finding already applied', { code: 'CONFLICT', status: 409 });
  }

  const current = await buildEvaluationStructure(id, vid);
  if (!current) throw new NotFoundError('Questionnaire version not found');

  const outcome = await applyFinding({
    finding: scopedFinding.row,
    runId,
    scoped: scopedVersion,
    snapshot: scopedFinding.snapshot,
    current,
    audit: { userId: adminId, clientIp },
  });

  if (outcome.status === 'unapplicable') {
    log.info('Questionnaire design-evaluation finding not applicable', {
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

  // Re-load + derive the finding (now `applied`) for the response body.
  const updated = await loadScopedFinding(vid, runId, findingId);
  const view = updated ? await buildScopedFindingView(updated) : null;

  log.info('Questionnaire design-evaluation finding applied', {
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
