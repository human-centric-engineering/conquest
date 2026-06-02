/**
 * Single-question endpoint (F2.1 / PR2).
 *
 * PATCH  …/versions/:vid/questions/:questionId — edit fields, change type (with a
 *   compatible `typeConfig`), set an explicit `key`, or move the question to
 *   another section (`sectionId` [+ `ordinal`]).
 * DELETE …/versions/:vid/questions/:questionId — remove the question.
 *
 * Questions are addressed by flat id (globally unique) — the parent section is in
 * the body for a move, not the path. Both verbs fork a launched version first and
 * retarget the question id (and any move-target section id) through the fork map.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { ValidationError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { Prisma } from '@prisma/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { updateQuestionSchema, validateTypeConfig } from '@/lib/app/questionnaire/authoring';
import type { QuestionType } from '@/lib/app/questionnaire/types';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  asKeyConflict,
  assertKeyAvailable,
  forkMeta,
  jsonInput,
  loadScopedVersion,
  resolveForkedId,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

type Params = { id: string; vid: string; questionId: string };

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

/** Load a question scoped to the version, or `null` (→ 404). */
async function scopedQuestion(versionId: string, questionId: string) {
  return prisma.appQuestionSlot.findFirst({
    where: { id: questionId, versionId },
    select: QUESTION_SELECT,
  });
}

const handlePatch = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, questionId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const existing = await scopedQuestion(vid, questionId);
  if (!existing) return errorResponse('Question not found', { code: 'NOT_FOUND', status: 404 });

  const body = await validateRequestBody(request, updateQuestionSchema);

  // Resolve the effective type and validate config when either is changing. A
  // type change RESETS the config (the new type's default/none) unless a fresh
  // `typeConfig` is supplied — so the stale config of the old type is never
  // re-validated against the new type. A typeConfig-only edit validates against
  // the stored type.
  const effectiveType = (body.type ?? existing.type) as QuestionType;
  let typeConfigData: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined;
  if (body.type !== undefined || body.typeConfig !== undefined) {
    const raw =
      body.typeConfig !== undefined
        ? body.typeConfig
        : body.type !== undefined
          ? undefined // type changed, no fresh config → reset to the new type's default
          : existing.typeConfig;
    const tc = validateTypeConfig(effectiveType, raw);
    if (!tc.ok) {
      throw new ValidationError('Invalid type configuration', {
        typeConfig: tc.issues.map((i) => i.message),
      });
    }
    typeConfigData = tc.value == null ? Prisma.JsonNull : jsonInput(tc.value);
  }

  // Reject an explicit-key collision BEFORE forking, so a doomed key edit on a
  // launched version doesn't leave an orphan draft (checked on the original
  // version — the fork copies keys 1:1).
  if (body.key !== undefined) await assertKeyAvailable(vid, body.key, questionId);

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const editId = fork.versionId;
  const targetId = resolveForkedId(fork, 'question', questionId);
  if (!targetId) return errorResponse('Question not found', { code: 'NOT_FOUND', status: 404 });

  // Resolve a move target (the body's sectionId is the original version's id).
  let moveSectionId: string | undefined;
  let moveOrdinal: number | undefined;
  if (body.sectionId !== undefined) {
    const mapped = resolveForkedId(fork, 'section', body.sectionId);
    const target =
      mapped &&
      (await prisma.appQuestionnaireSection.findFirst({
        where: { id: mapped, versionId: editId },
        select: { id: true },
      }));
    if (!target) {
      throw new ValidationError('Target section is not in this version', {
        sectionId: ['Unknown section id'],
      });
    }
    moveSectionId = target.id;
    // Append at the end of the target section. Exclude the question being moved
    // from the count so a same-section move doesn't count itself (→ an ordinal one
    // past the end / a gap).
    moveOrdinal =
      body.ordinal ??
      (await prisma.appQuestionSlot.count({
        where: { sectionId: target.id, NOT: { id: targetId } },
      }));
  } else if (body.ordinal !== undefined) {
    moveOrdinal = body.ordinal;
  }

  const data: Prisma.AppQuestionSlotUpdateInput = {};
  if (body.prompt !== undefined) data.prompt = body.prompt;
  if (body.type !== undefined) data.type = body.type;
  if (body.key !== undefined) data.key = body.key;
  if (body.guidelines !== undefined) data.guidelines = body.guidelines;
  if (body.rationale !== undefined) data.rationale = body.rationale;
  if (body.required !== undefined) data.required = body.required;
  if (body.weight !== undefined) data.weight = body.weight;
  if (typeConfigData !== undefined) data.typeConfig = typeConfigData;
  if (moveSectionId !== undefined) data.section = { connect: { id: moveSectionId } };
  if (moveOrdinal !== undefined) data.ordinal = moveOrdinal;

  try {
    const updated = await prisma.appQuestionSlot.update({
      where: { id: targetId },
      data,
      select: QUESTION_SELECT,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_question.update',
      entityType: 'questionnaire_question',
      entityId: targetId,
      entityName: updated.key,
      changes: computeChanges(existing, updated, { ignoreKeys: ['id'] }),
      clientIp,
    });
    log.info('Questionnaire question updated', { versionId: editId, questionId: targetId });

    return successResponse(updated, forkMeta(fork));
  } catch (err) {
    asKeyConflict(err);
  }
});

const handleDelete = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, questionId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const existing = await scopedQuestion(vid, questionId);
  if (!existing) return errorResponse('Question not found', { code: 'NOT_FOUND', status: 404 });

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const targetId = resolveForkedId(fork, 'question', questionId);
  if (!targetId) return errorResponse('Question not found', { code: 'NOT_FOUND', status: 404 });

  await prisma.appQuestionSlot.delete({ where: { id: targetId } });

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_question.delete',
    entityType: 'questionnaire_question',
    entityId: targetId,
    entityName: existing.key,
    metadata: { questionnaireId: id, versionId: fork.versionId },
    clientIp,
  });
  log.info('Questionnaire question deleted', { versionId: fork.versionId, questionId: targetId });

  return successResponse({ id: targetId, deleted: true }, forkMeta(fork));
});

export const PATCH = withQuestionnairesEnabled(handlePatch);

export const DELETE = withQuestionnairesEnabled(handleDelete);
