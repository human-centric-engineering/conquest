/**
 * Single data-slot refinement (preview) — Data Slots feature.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/data-slots/refine
 *   Admin-only. Refines ONE data slot per the admin's free-text instructions, re-grounded against
 *   the version's full question set (so the model may also re-suggest which questions the slot
 *   covers). Returns the single refined slot. Persists NOTHING: the admin's working set is the
 *   source of truth and is committed via PUT — a refine is just an LLM-assisted edit to one card.
 *   Per-admin sub-cap (paid LLM work).
 *   Fail-soft: a refiner failure returns `slot: null` + a diagnostic rather than a 5xx.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import {
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
  REFINE_DATA_SLOT_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { RefineDataSlotData } from '@/lib/app/questionnaire/capabilities';
import { refineDataSlotRequestSchema } from '@/lib/app/questionnaire/data-slots';
import { buildDataSlotStructure } from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import { dataSlotsRefineLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const handleRefine = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const rl = dataSlotsRefineLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Data-slot refine rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const body = refineDataSlotRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse('Invalid refinement request', {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { issues: body.error.issues },
      });
    }
    const { instructions, slot, siblingSlots } = body.data;

    const structure = await buildDataSlotStructure(id, vid);
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found or has no questions');
    }

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      log.error('Data-slot generator agent not found; run db:seed', {
        slug: QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
      });
      throw new NotFoundError('Data-slot refinement is not configured');
    }

    // Flush the built-in + app capability handlers into the dispatcher before dispatching — this
    // route may be the first capability touch on a fresh server process. Same one-shot, idempotent
    // flush the generate route and the live turn loop perform.
    registerBuiltInCapabilities();

    const dispatch = await capabilityDispatcher.dispatch(
      REFINE_DATA_SLOT_CAPABILITY_SLUG,
      { structure, slot, instructions, siblingSlots, versionId: vid },
      {
        userId: adminId,
        agentId: agent.id,
        entityContext: {
          dataSlotsAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );

    if (!dispatch.success || !dispatch.data) {
      log.warn('Data-slot refine failed (fail-soft)', {
        questionnaireId: id,
        versionId: vid,
        code: dispatch.error?.code,
        message: dispatch.error?.message,
      });
      return successResponse({
        slot: null,
        diagnostic: dispatch.error?.code ?? 'refine_failed',
        diagnosticMessage: dispatch.error?.message,
      });
    }

    const data = dispatch.data as RefineDataSlotData;

    log.info('Data slot refined', { questionnaireId: id, versionId: vid });

    return successResponse({ slot: data.slot });
  }
);

export const POST = handleRefine;
