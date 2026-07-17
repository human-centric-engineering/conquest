/**
 * Generative-authoring refine endpoint (conversational refinement turn).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/compose/refine
 *   Admin-only. Applies one natural-language instruction ("make it shorter", "add a
 *   section on pricing") to a draft version's current structure and rewrites the
 *   version's section→slot graph from the composer's full updated structure.
 *   Returns the updated structure (for the live preview) plus a one-line summary of
 *   what changed. Guarded to **draft** versions with **no respondent sessions** — a
 *   refine never rewrites a launched/in-flight graph.
 *
 * Auth: admin only. Flag: 404 when the master OR generative-authoring sub-flag is
 * off. Rate limit: per-admin compose sub-cap (shared with the compose routes).
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import type { RefineQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  loadComposerAgent,
  loadRefinableStructure,
} from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import {
  assertPersistable,
  IncoherentExtractionError,
  replaceVersionStructure,
} from '@/app/api/v1/app/questionnaires/_lib/persist';
import { refineRequestSchema } from '@/app/api/v1/app/questionnaires/_lib/compose-input';

/** Map a refine dispatch error code to an HTTP status. */
function dispatchStatus(code: string | undefined): number {
  switch (code) {
    case 'rate_limited':
      return 429;
    case 'invalid_args':
      return 400;
    case 'no_provider_configured':
    case 'provider_unavailable':
    case 'capability_inactive':
    case 'capability_disabled_for_agent':
    case 'unknown_capability':
    case 'capability_quarantined':
    case 'requires_approval':
      return 503;
    default:
      return 502;
  }
}

const handleRefine = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIP = getClientIP(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const rl = composeLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Questionnaire refine rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const body = refineRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse('Invalid refine request', {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { issues: body.error.issues },
      });
    }
    const { instruction } = body.data;

    // Load + guard the draft structure (404 / 409 on a bad target).
    const current = await loadRefinableStructure(id, vid);
    if (!current.ok) return current.response;

    const agentResult = await loadComposerAgent(log);
    if (!agentResult.ok) return agentResult.response;
    const agent = agentResult.value;

    registerBuiltInCapabilities();
    const dispatch = await capabilityDispatcher.dispatch(
      REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
      { currentStructure: current.value, instruction },
      {
        userId: adminId,
        agentId: agent.id,
        entityContext: {
          composerAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );

    if (!dispatch.success || !dispatch.data) {
      const status = dispatchStatus(dispatch.error?.code);
      log.warn('Questionnaire refine failed', {
        adminId,
        versionId: vid,
        capabilityError: dispatch.error?.code,
        status,
      });
      return errorResponse(dispatch.error?.message ?? 'Refinement failed', {
        code: 'REFINEMENT_FAILED',
        status,
        ...(dispatch.error?.code ? { details: { capabilityError: dispatch.error.code } } : {}),
      });
    }

    const refined = dispatch.data as RefineQuestionnaireStructureData;

    // Coherence pre-check before opening a transaction.
    try {
      assertPersistable(refined.structure);
    } catch (err) {
      if (err instanceof IncoherentExtractionError) {
        log.warn('Questionnaire refine incoherent', {
          adminId,
          versionId: vid,
          orphanSectionOrdinals: err.orphanSectionOrdinals,
        });
        return errorResponse(err.message, {
          code: 'REFINEMENT_INCOHERENT',
          status: 422,
          details: { orphanSectionOrdinals: err.orphanSectionOrdinals },
        });
      }
      throw err;
    }

    const counts = await replaceVersionStructure(vid, refined.structure);

    logAdminAction({
      userId: adminId,
      action: 'questionnaire.refine',
      entityType: 'questionnaire',
      entityId: vid,
      entityName: instruction.slice(0, 80),
      metadata: {
        questionnaireId: id,
        versionId: vid,
        sectionCount: counts.sectionCount,
        questionCount: counts.questionCount,
      },
      clientIp: clientIP,
    });

    log.info('Questionnaire refined', {
      adminId,
      questionnaireId: id,
      versionId: vid,
      sectionCount: counts.sectionCount,
      questionCount: counts.questionCount,
    });

    return successResponse({
      summary: refined.summary,
      sectionCount: counts.sectionCount,
      questionCount: counts.questionCount,
      structure: {
        sections: refined.structure.sections,
        questions: refined.structure.questions,
        ...(refined.structure.inferredGoal !== undefined
          ? { goal: refined.structure.inferredGoal }
          : {}),
        ...(refined.structure.inferredAudience !== undefined
          ? { audience: refined.structure.inferredAudience }
          : {}),
      },
    });
  }
);

export const POST = handleRefine;
