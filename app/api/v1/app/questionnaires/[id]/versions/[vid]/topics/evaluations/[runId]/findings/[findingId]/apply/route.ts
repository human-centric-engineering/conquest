/**
 * Apply one scope-evaluation finding to the draft version (F17.21).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/topics/evaluations/:runId/findings/:findingId/apply
 *   (no body)
 *
 *   Admin-only. Executes the finding's structured edit (`editedOverride ?? proposedEdit`) on the
 *   draft version through the fork-if-launched authoring seam, then marks the finding `applied`.
 *   Takes the apply sub-cap (apply may fork a launched version).
 *
 *   An edit that can't be applied returns **409** with a reason the UI acts on: `stale` (config
 *   drifted — re-run), `target_gone` (the target was deleted), `op_invalid`, or `needs_authoring`
 *   (prose-only — edit the Topics tab by hand). On success the response `meta` carries the fork
 *   outcome so the queue can re-point to the new draft.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { scopeEvaluationApplyLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { buildScopeEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/scope-evaluation-structure';
import {
  applyScopeFinding,
  findRunReviewDraft,
} from '@/app/api/v1/app/questionnaires/_lib/scope-evaluation-apply';
import {
  buildScopedScopeFindingView,
  loadScopedScopeFinding,
} from '@/app/api/v1/app/questionnaires/_lib/scope-evaluation-run-routes';

type Params = { id: string; vid: string; runId: string; findingId: string };

const handleApply = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, runId, findingId } = await params;
  const adminId = session.user.id;

  const rl = scopeEvaluationApplyLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Scope-evaluation-apply rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const scopedVersion = await loadScopedVersion(id, vid);
  if (!scopedVersion) throw new NotFoundError('Questionnaire version not found');

  const scopedFinding = await loadScopedScopeFinding(vid, runId, findingId);
  if (!scopedFinding) throw new NotFoundError('Scope evaluation finding not found');

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
  const current = await buildScopeEvaluationStructure(id, reuseDraft?.id ?? vid);
  if (!current) throw new NotFoundError('Questionnaire version not found');

  const outcome = await applyScopeFinding({
    finding: scopedFinding.row,
    runId,
    scoped: scopedVersion,
    snapshot: scopedFinding.snapshot,
    current,
    audit: { userId: adminId, clientIp },
  });

  if (outcome.status === 'unapplicable') {
    log.info('Adaptive Scope evaluation finding not applicable', {
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

  const updated = await loadScopedScopeFinding(vid, runId, findingId);
  const view = updated ? await buildScopedScopeFindingView(updated) : null;

  log.info('Adaptive Scope evaluation finding applied', {
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
