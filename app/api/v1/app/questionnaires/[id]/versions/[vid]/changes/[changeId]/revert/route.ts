/**
 * Extraction-change revert endpoint (F2.3).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/changes/:changeId/revert
 *   Admin-only: revert one extraction change, restoring the version graph to its
 *   pre-change state. A POST (an action over multiple rows), not a PATCH.
 *
 * Flow (the order is load-bearing):
 *   scope-404 version → scope-404 change → 409 if already reverted → dry-run the
 *   pure planner BEFORE forking (422 REVERT_IMPOSSIBLE on a doomed revert, so no
 *   orphan draft) → fork the launched version → re-plan + execute against the
 *   editable version → mark the SOURCE change row reverted → audit → 200 (+ fork
 *   meta so the UI redirects to the draft).
 *
 * Fork subtlety: a fork starts a clean editorial lineage (it copies no change
 * records), so on a launched version the inverse mutation is applied to the draft
 * while the change row that records the decision stays — now `reverted` — on the
 * source version.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { ConflictError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { planRevert } from '@/lib/app/questionnaire/extraction-review';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  buildGraphSnapshot,
  executeRevert,
  loadScopedChange,
  toRevertableChange,
} from '@/app/api/v1/app/questionnaires/_lib/extraction-review-routes';

type Params = { id: string; vid: string; changeId: string };

const handleRevert = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, changeId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped) {
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
  }

  const change = await loadScopedChange(vid, changeId);
  if (!change) {
    return errorResponse('Extraction change not found', { code: 'NOT_FOUND', status: 404 });
  }

  // Only an applied change is revertible; a re-revert is a 409 (idempotency guard).
  if (change.status !== 'applied') {
    throw new ConflictError('This change has already been reverted');
  }

  const revertable = toRevertableChange(change);

  // Dry-run the pure planner against the CURRENT version before forking. A doomed
  // revert (ambiguous/missing target, structural inverse, drift) returns 422 here
  // so a launched version isn't forked into an orphan draft.
  const preSnapshot = await buildGraphSnapshot(vid);
  const dry = planRevert(revertable, preSnapshot);
  if (!dry.ok) {
    return errorResponse(dry.detail, {
      code: 'REVERT_IMPOSSIBLE',
      status: 422,
      details: { reason: dry.reason },
    });
  }

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const editId = fork.versionId;

  // Re-plan against the editable (possibly forked) version — a fork is a 1:1 copy
  // so the plan holds; re-check defensively and 422 before any write if a race
  // changed the graph.
  const snapshot = await buildGraphSnapshot(editId);
  const planned = planRevert(revertable, snapshot);
  if (!planned.ok) {
    return errorResponse(planned.detail, {
      code: 'REVERT_IMPOSSIBLE',
      status: 422,
      details: { reason: planned.reason },
    });
  }

  await executeRevert({
    editVersionId: editId,
    changeId: change.id,
    plan: planned.plan,
    revertedByUserId: session.user.id,
    revertedAt: new Date(),
  });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_change.revert',
    entityType: 'questionnaire_extraction_change',
    entityId: change.id,
    entityName: change.changeType,
    changes: computeChanges({ status: 'applied' }, { status: 'reverted' }),
    metadata: {
      questionnaireId: id,
      versionId: editId,
      sourceVersionId: vid,
      changeType: change.changeType,
      targetEntityType: change.targetEntityType,
    },
    clientIp,
  });
  log.info('Questionnaire extraction change reverted', {
    versionId: editId,
    changeId: change.id,
    changeType: change.changeType,
  });

  return successResponse(
    { id: change.id, status: 'reverted', summary: planned.plan.summary },
    forkMeta(fork)
  );
});

export const POST = withQuestionnairesEnabled(handleRevert);
