/**
 * Review one policy-evaluation finding (F18.8).
 *
 * PATCH /api/v1/app/questionnaires/:id/versions/:vid/policy/evaluations/:runId/findings/:findingId
 *   body: { action: 'accept' | 'decline' }
 *       | { action: 'edit', editedOverride: PolicyProposedEdit }
 *       | { action: 'mark_applied', appliedToVersionId: string }
 *
 *   Admin-only. Triage a finding: `accept` (agree, not yet applied), `decline` (dismiss), `edit`
 *   (store an admin-edited override op that takes precedence at apply), or `mark_applied` (the
 *   admin already made the change by hand on the Settings tab — stamp the finding's terminal state
 *   without mutating the config again). The one-click structural mutation is the separate
 *   `…/apply` POST. A finding already `applied` is terminal → 409.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { policyReviewFindingSchema } from '@/lib/app/questionnaire/policy-evaluation';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import {
  buildScopedPolicyFindingView,
  loadScopedPolicyFinding,
} from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-run-routes';

type Params = { id: string; vid: string; runId: string; findingId: string };

const handleReview = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, runId, findingId } = await params;

  const scoped = await loadScopedPolicyFinding(vid, runId, findingId);
  if (!scoped) throw new NotFoundError('Policy evaluation finding not found');

  if (scoped.row.status === 'applied') {
    return errorResponse('Finding already applied', { code: 'CONFLICT', status: 409 });
  }

  const body = await validateRequestBody(request, policyReviewFindingSchema);

  let data: Prisma.AppQuestionnairePolicyEvaluationFindingUncheckedUpdateInput;
  if (body.action === 'accept') {
    data = { status: 'accepted', decidedByUserId: session.user.id, decidedAt: new Date() };
  } else if (body.action === 'decline') {
    data = { status: 'declined', decidedByUserId: session.user.id, decidedAt: new Date() };
  } else if (body.action === 'edit') {
    data = {
      editedOverride: jsonInput(body.editedOverride),
      decidedByUserId: session.user.id,
      decidedAt: new Date(),
    };
  } else {
    const target = await prisma.appQuestionnaireVersion.findFirst({
      where: { id: body.appliedToVersionId, questionnaireId: id },
      select: { id: true },
    });
    if (!target)
      return errorResponse('Target version not found', { code: 'NOT_FOUND', status: 404 });
    data = {
      status: 'applied',
      appliedAt: new Date(),
      appliedToVersionId: body.appliedToVersionId,
      decidedByUserId: session.user.id,
      decidedAt: new Date(),
    };
  }

  await prisma.appQuestionnairePolicyEvaluationFinding.update({ where: { id: findingId }, data });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_policy_evaluation_finding.decide',
    entityType: 'questionnaire_policy_evaluation_finding',
    entityId: findingId,
    metadata: { questionnaireId: id, versionId: vid, runId, reviewAction: body.action },
    clientIp,
  });

  const updated = await loadScopedPolicyFinding(vid, runId, findingId);
  if (!updated) throw new NotFoundError('Policy evaluation finding not found');
  const view = await buildScopedPolicyFindingView(updated);

  log.info('Interviewer-policy evaluation finding reviewed', {
    versionId: vid,
    runId,
    findingId,
    action: body.action,
    status: view.status,
  });

  return successResponse(view);
});

export const PATCH = handleReview;
