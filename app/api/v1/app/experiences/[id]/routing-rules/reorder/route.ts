/**
 * Reorder an experience's routing rules (F15.2 deferred item).
 *
 * PATCH body: { ruleIds: string[] } — the COMPLETE ordered list.
 *
 * Rule order is behaviour, not presentation: `evaluateRoutingRules` takes the first match by
 * ordinal, so moving a rule changes where respondents go. That is why the editor needed this and
 * why it takes the whole list.
 *
 * Same contract as the step reorder, for the same reason: anything that is not exactly the current
 * rule set is refused — duplicates 400, foreign ids 400, a size mismatch 409 — so a stale page
 * fails loudly instead of writing an order derived from a set that no longer exists. Do not
 * "improve" this into a moved-item delta: two concurrent drags would interleave into an order
 * neither author chose.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

type Params = { id: string };

const reorderSchema = z.object({
  ruleIds: z.array(z.string().min(1).max(64)).min(1),
});

const handleReorder = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;
  const body = await validateRequestBody(request, reorderSchema);

  if (new Set(body.ruleIds).size !== body.ruleIds.length) {
    return errorResponse('The list contains duplicate rule ids', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }

  const existing = await prisma.appExperienceRoutingRule.findMany({
    where: { experienceId: id },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((r) => r.id));

  if (body.ruleIds.length !== existing.length) {
    return errorResponse('The list does not match this experience’s rules — reload and try again', {
      code: 'CONFLICT',
      status: 409,
    });
  }
  if (body.ruleIds.some((ruleId) => !existingIds.has(ruleId))) {
    return errorResponse('The list contains a rule from another experience', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }

  await prisma.$transaction(
    body.ruleIds.map((ruleId, ordinal) =>
      prisma.appExperienceRoutingRule.update({ where: { id: ruleId }, data: { ordinal } })
    )
  );

  log.info('Experience routing rules reordered', { experienceId: id, count: body.ruleIds.length });
  return successResponse({ ruleIds: body.ruleIds });
});

export const PATCH = handleReorder;
