/**
 * Duplicate endpoint — the general-purpose "make a copy" action.
 *
 * POST /api/v1/app/questionnaires/:id/duplicate
 *   Copy the questionnaire's **current** version (launched if present, else the
 *   highest-numbered) into a brand-new questionnaire as a fresh `draft` v1 —
 *   structure + tags + config + goal/audience + source-doc provenance, via the
 *   shared `duplicateQuestionnaire` service. Does NOT copy sessions, invitations,
 *   evaluation runs, or extraction-change records (a copy starts clean).
 *
 * Unlike the DEMO-ONLY `clone-for-client` route, this carries no demo-client
 * attribution — it produces a plain, unattributed copy titled "… — Copy" (or a
 * caller-supplied suffix). It shares the same create+copy core, so the two can
 * never drift, and it survives a fork that strips the demo clone route.
 *
 * Pipeline: flag-gate → withAdminAuth → Zod body → service → source/version 404 →
 * admin audit → 201 `{ questionnaireId, versionId }`. Auth: admin only. No sub-cap —
 * the 100/min section cap suffices (bounded, no LLM call).
 */

import { z } from 'zod';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { duplicateQuestionnaire } from '@/app/api/v1/app/questionnaires/_lib/duplicate-questionnaire';

const duplicateSchema = z.object({
  /** Optional title suffix; defaults to "Copy" when omitted. */
  nameSuffix: z.string().trim().max(120).optional(),
});

const handleDuplicate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  const body = await validateRequestBody(request, duplicateSchema);

  const result = await duplicateQuestionnaire({
    sourceId: id,
    ...(body.nameSuffix ? { nameSuffix: body.nameSuffix } : {}),
  });

  if (!result.ok) {
    if (result.code === 'SOURCE_NOT_FOUND') {
      return errorResponse('Questionnaire not found', { code: 'NOT_FOUND', status: 404 });
    }
    return errorResponse('Questionnaire has no version to duplicate', {
      code: 'NOT_FOUND',
      status: 404,
    });
  }

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire.duplicate',
    entityType: 'questionnaire',
    entityId: result.questionnaireId,
    metadata: {
      sourceQuestionnaireId: id,
      sourceVersionId: result.sourceVersionId,
      newVersionId: result.versionId,
    },
    clientIp,
  });
  log.info('Questionnaire duplicated', {
    sourceQuestionnaireId: id,
    newQuestionnaireId: result.questionnaireId,
  });

  return successResponse(
    { questionnaireId: result.questionnaireId, versionId: result.versionId },
    undefined,
    { status: 201 }
  );
});

export const POST = handleDuplicate;
