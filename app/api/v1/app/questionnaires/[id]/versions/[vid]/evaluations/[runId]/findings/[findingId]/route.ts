/**
 * Review one design-evaluation finding (F5.3).
 *
 * PATCH /api/v1/app/questionnaires/:id/versions/:vid/evaluations/:runId/findings/:findingId
 *   body: { action: 'accept' | 'decline' }
 *       | { action: 'edit', editedOverride: ProposedEdit }
 *       | { action: 'mark_applied', appliedToVersionId: string }
 *
 *   Admin-only. Triage a finding: `accept` (agree, not yet applied), `decline` (dismiss),
 *   `edit` (store an admin-edited override op that takes precedence at apply), or `mark_applied`
 *   (the suggestion was authored by hand in the editor — stamp the finding's terminal state +
 *   the version it landed in). This is the review-queue write; it never mutates the questionnaire
 *   structure (that's the explicit `…/apply` POST — `mark_applied` only records that the editor
 *   already did the authoring). Sub-flag gated — a decision is part of the paid design-evaluation
 *   sub-feature, so it 404s when the sub-flag is off (the reads stay master-flag only).
 *
 *   A finding already `applied` is terminal → 409.
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
import { reviewFindingSchema } from '@/lib/app/questionnaire/evaluation';
import { jsonInput } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  buildScopedFindingView,
  loadScopedFinding,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';

type Params = { id: string; vid: string; runId: string; findingId: string };

const handleReview = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, runId, findingId } = await params;

  const scoped = await loadScopedFinding(vid, runId, findingId);
  if (!scoped) throw new NotFoundError('Evaluation finding not found');

  if (scoped.row.status === 'applied') {
    return errorResponse('Finding already applied', { code: 'CONFLICT', status: 409 });
  }

  const body = await validateRequestBody(request, reviewFindingSchema);

  let data: Prisma.AppQuestionnaireEvaluationFindingUncheckedUpdateInput;
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
    // mark_applied: the question was authored in the editor. Pin it to a draft of THIS
    // questionnaire so a caller can't mark a finding applied against an unrelated version.
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

  await prisma.appQuestionnaireEvaluationFinding.update({ where: { id: findingId }, data });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_evaluation_finding.decide',
    entityType: 'questionnaire_evaluation_finding',
    entityId: findingId,
    metadata: { questionnaireId: id, versionId: vid, runId, reviewAction: body.action },
    clientIp,
  });

  // Re-load + derive so the response carries the fresh status + recomputed stale/applicable.
  const updated = await loadScopedFinding(vid, runId, findingId);
  if (!updated) throw new NotFoundError('Evaluation finding not found');
  const view = await buildScopedFindingView(updated);

  log.info('Questionnaire design-evaluation finding reviewed', {
    versionId: vid,
    runId,
    findingId,
    action: body.action,
    status: view.status,
  });

  return successResponse(view);
});

export const PATCH = handleReview;
