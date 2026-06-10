/**
 * Data-slot generation (preview) — Data Slots feature.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/data-slots/generate
 *   Admin-only. Runs the data-slot generator over a version's approved questions and returns
 *   the proposed slots (short names + descriptions + question mappings). A read-only preview:
 *   it persists nothing — the admin reviews + saves via PUT. Gated by the master flag AND the
 *   data-slots sub-flag (paid LLM work). Per-admin sub-cap. Fail-soft: a generator failure
 *   returns an empty set + a diagnostic rather than a 5xx.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import {
  isDataSlotsEnabled,
  withQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_DATA_SLOTS_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { GenerateDataSlotsData } from '@/lib/app/questionnaire/capabilities';
import { buildDataSlotStructure } from '@/app/api/v1/app/questionnaires/_lib/data-slot-routes';
import { dataSlotsGenerationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const handleGenerate = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    if (!(await isDataSlotsEnabled())) {
      throw new NotFoundError('Data slots are not enabled');
    }

    const rl = dataSlotsGenerationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Data-slots generation rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

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
      throw new NotFoundError('Data-slot generation is not configured');
    }

    // Flush the built-in + app capability handlers into the dispatcher before dispatching. This
    // route may be the FIRST capability touch on a fresh server process (an admin generating data
    // slots before any chat/turn has run), and the dispatcher does not lazy-register — without
    // this the handler map is empty and the dispatch returns `unknown_capability` (fail-soft to
    // an empty set). Same one-shot, idempotent flush the live turn loop performs.
    registerBuiltInCapabilities();

    const dispatch = await capabilityDispatcher.dispatch(
      GENERATE_DATA_SLOTS_CAPABILITY_SLUG,
      { structure, versionId: vid },
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
      log.warn('Data-slots generation failed (fail-soft)', {
        questionnaireId: id,
        versionId: vid,
        code: dispatch.error?.code,
      });
      return successResponse({
        slots: [],
        diagnostic: dispatch.error?.code ?? 'generation_failed',
      });
    }

    const data = dispatch.data as GenerateDataSlotsData;
    log.info('Data slots generated', {
      questionnaireId: id,
      versionId: vid,
      slotCount: data.slots.length,
    });

    return successResponse({ slots: data.slots });
  }
);

export const POST = withQuestionnairesEnabled(handleGenerate);
