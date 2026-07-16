/**
 * Question collection endpoint (F2.1 / PR2).
 *
 * POST …/versions/:vid/sections/:sectionId/questions
 *   Admin-only: add a question to a section. Forks a launched version first
 *   (retargeting the parent section through the fork). `key` is derived from the
 *   prompt when omitted (collision-suffixed); an explicit key that collides 400s.
 *   `typeConfig` is validated against `type` at the boundary. `ordinal` appends.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { ValidationError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { createQuestionSchema, validateTypeConfig } from '@/lib/app/questionnaire/authoring';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  asKeyConflict,
  forkMeta,
  jsonInput,
  assertKeyAvailable,
  loadScopedVersion,
  resolveForkedId,
  resolveQuestionKey,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

type Params = { id: string; vid: string; sectionId: string };

const QUESTION_SELECT = {
  id: true,
  sectionId: true,
  ordinal: true,
  key: true,
  prompt: true,
  guidelines: true,
  rationale: true,
  type: true,
  typeConfig: true,
  required: true,
  weight: true,
} as const;

const handleCreateQuestion = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, sectionId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const section = await prisma.appQuestionnaireSection.findFirst({
    where: { id: sectionId, versionId: vid },
    select: { id: true },
  });
  if (!section) return errorResponse('Section not found', { code: 'NOT_FOUND', status: 404 });

  const body = await validateRequestBody(request, createQuestionSchema);

  // Validate type config against the requested type before any write.
  const tc = validateTypeConfig(body.type, body.typeConfig);
  if (!tc.ok) {
    throw new ValidationError('Invalid type configuration', {
      typeConfig: tc.issues.map((i) => i.message),
    });
  }

  // Reject an explicit-key collision before forking, so a doomed create on a
  // launched version doesn't leave an orphan draft (the fork copies keys 1:1).
  if (body.key !== undefined) await assertKeyAvailable(vid, body.key);

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const editId = fork.versionId;
  const parentSectionId = resolveForkedId(fork, 'section', sectionId);
  if (!parentSectionId)
    return errorResponse('Section not found', { code: 'NOT_FOUND', status: 404 });

  const key = await resolveQuestionKey(editId, body.key, body.prompt);
  const ordinal =
    body.ordinal ?? (await prisma.appQuestionSlot.count({ where: { sectionId: parentSectionId } }));

  try {
    const question = await prisma.appQuestionSlot.create({
      data: {
        versionId: editId,
        sectionId: parentSectionId,
        ordinal,
        key,
        prompt: body.prompt,
        type: body.type,
        required: body.required ?? false,
        weight: body.weight ?? 0.5,
        typeConfig: tc.value == null ? Prisma.JsonNull : jsonInput(tc.value),
        ...(body.guidelines != null ? { guidelines: body.guidelines } : {}),
        ...(body.rationale != null ? { rationale: body.rationale } : {}),
      },
      select: QUESTION_SELECT,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_question.create',
      entityType: 'questionnaire_question',
      entityId: question.id,
      entityName: question.key,
      metadata: { questionnaireId: id, versionId: editId, sectionId: parentSectionId },
      clientIp,
    });
    log.info('Questionnaire question created', { versionId: editId, questionId: question.id });

    return successResponse(question, forkMeta(fork), { status: 201 });
  } catch (err) {
    asKeyConflict(err); // P2002 on (versionId, key) → 400; rethrows otherwise
  }
});

export const POST = handleCreateQuestion;
