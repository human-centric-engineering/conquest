/**
 * Question tag-assignment endpoint (F2.2).
 *
 * PUT /api/v1/app/questionnaires/:id/versions/:vid/questions/:questionId/tags
 *   Admin-only: replace a question's entire tag set with `{ tagIds }` (empty array
 *   clears all). Idempotent. Every tag id must belong to the same version — a
 *   cross-version id is a 400, checked BEFORE forking so a doomed assignment leaves
 *   no orphan draft. Forks a launched version first, then retargets the question and
 *   remaps the tag ids through the fork map.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { executeTransaction } from '@/lib/db/utils';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { setQuestionTagsSchema } from '@/lib/app/questionnaire/tagging';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  forkMeta,
  loadScopedVersion,
  resolveForkedId,
} from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  resolveAssignableTags,
  type AssignableTag,
} from '@/app/api/v1/app/questionnaires/_lib/tagging-routes';

type Params = { id: string; vid: string; questionId: string };

const handlePut = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id, vid, questionId } = await params;

  const scoped = await loadScopedVersion(id, vid);
  if (!scoped)
    return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });

  const existing = await prisma.appQuestionSlot.findFirst({
    where: { id: questionId, versionId: vid },
    select: { id: true, key: true },
  });
  if (!existing) return errorResponse('Question not found', { code: 'NOT_FOUND', status: 404 });

  const body = await validateRequestBody(request, setQuestionTagsSchema);

  // Validate the tag ids against the ORIGINAL version before forking (cross-version
  // → 400, no orphan draft). The fork copies the vocabulary, so each validated row
  // remaps cleanly afterwards — and carries its label/color, so the response needs
  // no readback query.
  const validatedTags = await resolveAssignableTags(vid, body.tagIds);

  const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
  const editId = fork.versionId;
  const targetQuestionId = resolveForkedId(fork, 'question', questionId);
  if (!targetQuestionId)
    return errorResponse('Question not found', { code: 'NOT_FOUND', status: 404 });

  // After a fork the client-sent ids name the original version's tags — remap each
  // to its copy. Pre-fork they pass through unchanged. A null remap means a
  // validated tag vanished from the vocabulary between validation and the fork
  // snapshot (e.g. a concurrent delete) — surface it rather than silently assigning
  // a subset.
  const finalTags: AssignableTag[] = [];
  for (const tag of validatedTags) {
    const mappedId = resolveForkedId(fork, 'tag', tag.id);
    if (!mappedId) {
      return errorResponse('A selected tag is no longer available in this version', {
        code: 'CONFLICT',
        status: 409,
      });
    }
    finalTags.push({ ...tag, id: mappedId });
  }
  const finalTagIds = finalTags.map((t) => t.id);

  // Replace semantics: clear the question's links, then re-create the requested set
  // (deduped + version-checked above, so the @@unique never trips).
  await executeTransaction(async (tx) => {
    await tx.appQuestionSlotTag.deleteMany({ where: { questionSlotId: targetQuestionId } });
    if (finalTagIds.length > 0) {
      await tx.appQuestionSlotTag.createMany({
        data: finalTagIds.map((tagId) => ({ questionSlotId: targetQuestionId, tagId })),
      });
    }
  });

  // Response tags: built from the validated rows (label/color carried through the
  // remap), ordered by normalized label to match the read model.
  const tags = [...finalTags]
    .sort((a, b) => a.normalizedLabel.localeCompare(b.normalizedLabel))
    .map((t) => ({ id: t.id, label: t.label, color: t.color }));

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_tag.assign',
    entityType: 'questionnaire_question',
    entityId: targetQuestionId,
    entityName: existing.key,
    metadata: { questionnaireId: id, versionId: editId, tagIds: finalTagIds },
    clientIp,
  });
  log.info('Questionnaire question tags set', {
    versionId: editId,
    questionId: targetQuestionId,
    tagCount: finalTagIds.length,
  });

  return successResponse({ id: targetQuestionId, tags }, forkMeta(fork));
});

export const PUT = handlePut;
