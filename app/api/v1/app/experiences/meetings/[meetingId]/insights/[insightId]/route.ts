/**
 * One insight, as the facilitator walks the room through it (P15.5).
 *
 * PATCH body: { covered?: boolean, visibleToRespondents?: boolean }
 *
 * Two different acts on one row. `covered` is the walkthrough's own progress — what has been said
 * out loud. `visibleToRespondents` PUBLISHES a finding to the room's own screens, and is an
 * editorial decision the facilitator takes with the finding in front of them, never a side effect
 * of generation.
 *
 * Publishing cannot defeat the k-anonymity gate: `respondentVisibleInsights` requires BOTH the
 * support threshold and this flag, so ticking it on a thin finding shows nobody anything.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

import {
  setInsightCovered,
  setInsightVisible,
} from '@/app/api/v1/app/experiences/_lib/meeting-service';

type Params = { meetingId: string; insightId: string };

const patchSchema = z
  .object({
    covered: z.boolean().optional(),
    visibleToRespondents: z.boolean().optional(),
  })
  .refine((b) => b.covered !== undefined || b.visibleToRespondents !== undefined, {
    message: 'Provide covered or visibleToRespondents',
  });

const handlePatch = withAdminAuth<Params>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { meetingId, insightId } = await params;
  const body = await validateRequestBody(request, patchSchema);

  // Scoped by BOTH ids: an insight id from another meeting must 404, not silently update.
  const insight = await prisma.appExperienceInsight.findFirst({
    where: { id: insightId, meetingId },
    select: { id: true },
  });
  if (!insight) return errorResponse('Insight not found', { code: 'NOT_FOUND', status: 404 });

  if (body.covered !== undefined) await setInsightCovered(insightId, body.covered);
  if (body.visibleToRespondents !== undefined) {
    await setInsightVisible(insightId, body.visibleToRespondents);
  }

  log.info('Meeting insight updated', { meetingId, insightId, ...body });
  return successResponse({ id: insightId, ...body });
});

export const PATCH = handlePatch;
