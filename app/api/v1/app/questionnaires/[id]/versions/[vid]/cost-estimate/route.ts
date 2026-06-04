/**
 * Questionnaire version pre-launch cost estimate (F3.3).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/cost-estimate
 *   ?respondents=N   (optional, default 1, 1..10000)
 *
 *   Admin-only, read-only projection: estimates the LLM spend of running one
 *   respondent through this version's conversational session, and scales it to
 *   `respondents` for a per-questionnaire figure. Surfaced in the config editor
 *   and on the invitations page so an admin can size the budget before launch.
 *
 *   The session/turn engine (P4/P6) does not exist yet, so there is no real
 *   session history to calibrate against — the estimate is **heuristic**
 *   (`basedOn: 'heuristic'`). Pricing resolves through Sunrise's provider-agnostic
 *   model registry; a model with no registry price yields `pricingKnown: false`
 *   (token volume estimated, USD withheld) rather than a misleading $0.
 *
 *   No mutation, no audit, no LLM call (pure math) → no rate-limit sub-cap; the
 *   route inherits the section 100/min. 404 when the feature flag is off.
 *
 *   See `lib/app/questionnaire/cost-estimation/` for the methodology and
 *   `.context/app/questionnaire/cost-estimation.md` for the full guide.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { estimateTokens } from '@/lib/orchestration/chat/token-estimator';
import { getModel } from '@/lib/orchestration/llm/model-registry';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { estimateSessionCost } from '@/lib/app/questionnaire';
import { DEFAULT_QUESTIONNAIRE_CONFIG } from '@/lib/app/questionnaire/types';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

/**
 * Last-resort model when `defaultModels.chat` is unset (cold-start deployments),
 * so the estimate prices against *something* rather than collapsing. Matches the
 * workflow estimator's fallback.
 */
const FALLBACK_MODEL_ID = 'claude-sonnet-4-6';

const querySchema = z.object({
  respondents: z.coerce.number().int().min(1).max(10_000).default(1),
});

const handleCostEstimate = withAdminAuth<{ id: string; vid: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const { searchParams } = new URL(request.url);
    const parsed = querySchema.safeParse({
      respondents: searchParams.get('respondents') ?? undefined,
    });
    if (!parsed.success) {
      throw new ValidationError('Invalid query parameters', parsed.error.flatten().fieldErrors);
    }
    const { respondents } = parsed.data;

    const [slots, config, chatModel] = await Promise.all([
      prisma.appQuestionSlot.findMany({
        where: { versionId: vid },
        select: { prompt: true },
      }),
      prisma.appQuestionnaireConfig.findUnique({
        where: { versionId: vid },
        select: { maxQuestionsPerSession: true, minQuestionsAnswered: true },
      }),
      getDefaultModelForTaskOrNull('chat'),
    ]);

    const model = chatModel ?? FALLBACK_MODEL_ID;
    const priced = getModel(model);
    // Registry costs are 0 when a model's price is unknown — fold that into the
    // null contract the pure estimator reads as "pricing unknown".
    const inputCostPerMillion =
      priced && priced.inputCostPerMillion > 0 ? priced.inputCostPerMillion : null;
    const outputCostPerMillion =
      priced && priced.outputCostPerMillion > 0 ? priced.outputCostPerMillion : null;

    const promptTokensTotal = slots.reduce(
      (sum, slot) => sum + estimateTokens(slot.prompt, model),
      0
    );

    const estimate = estimateSessionCost({
      questionCount: slots.length,
      promptTokensTotal,
      maxQuestionsPerSession:
        config?.maxQuestionsPerSession ?? DEFAULT_QUESTIONNAIRE_CONFIG.maxQuestionsPerSession,
      minQuestionsAnswered:
        config?.minQuestionsAnswered ?? DEFAULT_QUESTIONNAIRE_CONFIG.minQuestionsAnswered,
      inputCostPerMillion,
      outputCostPerMillion,
      model,
      respondents,
    });

    log.info('Questionnaire cost estimate computed', {
      questionnaireId: id,
      versionId: vid,
      questionCount: slots.length,
      respondents,
      model,
      pricingKnown: estimate.pricingKnown,
      perSessionMidUsd: estimate.perSession.midUsd,
    });

    return successResponse(estimate);
  }
);

export const GET = withQuestionnairesEnabled(handleCostEstimate);
