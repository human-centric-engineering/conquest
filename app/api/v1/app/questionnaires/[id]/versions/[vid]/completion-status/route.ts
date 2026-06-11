/**
 * Questionnaire completion-status preview (F4.5).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/completion-status
 *   body: {
 *     answered: { key: string; confidence?: number | null }[]
 *     recentMessages?: string[]            // for the offer's tone, oldest → newest
 *     sessionId?: string
 *   }
 *
 *   Admin-only, READ-ONLY: it persists nothing. Runs the deterministic completion
 *   gate (`assessCompletion`) against a hand-supplied answer state and returns the
 *   {@link CompletionAssessment} — offer / not_ready / blocked_on_required, with the
 *   unmet criteria and the unanswered required keys. When the assessment is `offer`
 *   AND the completion sub-flag is on, it also dispatches the offer-composer
 *   capability to phrase the offer (the "agent contract"); fail-soft.
 *
 *   Gated by the master flag only — the deterministic assessment is free, so a
 *   disabled completion sub-flag does NOT 404 the route: it simply returns the
 *   assessment without a composed `offer`. The paid LLM phrasing takes a per-admin
 *   sub-cap. Its purpose is twofold: let admins sanity-check the completion gate
 *   before launch, and give the engine (P6) a proven assessment seam to call.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import {
  isCompletionEnabled,
  withQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
  QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { assessCompletion } from '@/lib/app/questionnaire/completion';
import type { CompletionOffer, CompletionPromptSlot } from '@/lib/app/questionnaire/completion';
import type { ComposeCompletionOfferData } from '@/lib/app/questionnaire/capabilities';
import { buildSelectionContext } from '@/app/api/v1/app/questionnaires/_lib/selection-context';
import { completionLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({
  answered: z
    .array(
      z.object({
        key: z.string().min(1),
        confidence: z.number().min(0).max(1).nullable().optional(),
      })
    )
    .max(10_000),
  recentMessages: z.array(z.string()).max(50).optional(),
  sessionId: z.string().max(200).optional(),
});

const handleCompletionStatus = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const body = await validateRequestBody(request, bodySchema);

    const built = await buildSelectionContext(id, vid, {
      answered: body.answered,
      ...(body.recentMessages !== undefined ? { recentMessages: body.recentMessages } : {}),
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
    });
    if (!built) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const { context } = built;
    const assessment = assessCompletion(context);

    // Compose the offer only when the gate says we may offer AND the operator has
    // enabled the (paid) completion phrasing. A disabled sub-flag is NOT a 404 — the
    // assessment alone is the useful, free result.
    let offer: CompletionOffer | undefined;
    let diagnostic: string | undefined;
    if (assessment.kind === 'offer' && (await isCompletionEnabled())) {
      const rl = completionLimiter.check(adminId);
      if (!rl.success) {
        log.warn('Completion rate limit exceeded', { adminId, reset: rl.reset });
        return createRateLimitResponse(rl);
      }

      const agent = await prisma.aiAgent.findUnique({
        where: { slug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG },
        select: { id: true, provider: true, model: true, fallbackProviders: true },
      });
      if (!agent) {
        log.error('Completion agent not found; run db:seed', {
          slug: QUESTIONNAIRE_COMPLETION_AGENT_SLUG,
        });
        throw new NotFoundError('Questionnaire completion is not configured');
      }

      // Recap material: answered questions (prompts only) + optional questions still
      // open. No respondent values — the recap is built from question prompts alone.
      const answeredIds = new Set(context.answered.map((a) => a.questionId));
      const coveredSlots: CompletionPromptSlot[] = [];
      const remainingSlots: CompletionPromptSlot[] = [];
      for (const q of context.questions) {
        const entry: CompletionPromptSlot = { key: q.key, prompt: q.prompt ?? '' };
        if (answeredIds.has(q.id)) coveredSlots.push(entry);
        else remainingSlots.push(entry);
      }

      // Flush capability handlers before dispatch — this route may be the first capability touch
      // on a fresh process (the dispatcher does not lazy-register). Idempotent, one-shot.
      registerBuiltInCapabilities();

      const dispatch = await capabilityDispatcher.dispatch(
        COMPOSE_COMPLETION_OFFER_CAPABILITY_SLUG,
        {
          coverage: assessment.coverage,
          answeredCount: assessment.answeredCount,
          capReached: assessment.capReached,
          coveredSlots,
          remainingSlots,
          recentMessages: body.recentMessages ?? [],
          sessionId: body.sessionId ?? `preview-${vid}`,
        },
        {
          userId: adminId,
          agentId: agent.id,
          entityContext: {
            completionAgent: {
              provider: agent.provider,
              model: agent.model,
              fallbackProviders: agent.fallbackProviders,
            },
          },
        }
      );

      // Fail-soft: a failed phrasing pass must not 5xx. Return the assessment with a
      // diagnostic and no composed offer so the engine (F4.6) can still proceed.
      if (dispatch.success && dispatch.data) {
        offer = (dispatch.data as ComposeCompletionOfferData).offer;
      } else {
        diagnostic = dispatch.error?.code ?? 'composition_failed';
        log.warn('Completion offer composition failed; returning assessment only', {
          questionnaireId: id,
          versionId: vid,
          code: dispatch.error?.code,
        });
      }
    }

    log.info('Questionnaire completion-status preview', {
      questionnaireId: id,
      versionId: vid,
      kind: assessment.kind,
      coverage: assessment.coverage,
      answeredCount: assessment.answeredCount,
      requiredUnanswered: assessment.requiredUnansweredKeys.length,
      composedOffer: offer !== undefined,
    });

    return successResponse({
      assessment,
      ...(offer !== undefined ? { offer } : {}),
      ...(diagnostic !== undefined ? { diagnostic } : {}),
    });
  }
);

export const POST = withQuestionnairesEnabled(handleCompletionStatus);
