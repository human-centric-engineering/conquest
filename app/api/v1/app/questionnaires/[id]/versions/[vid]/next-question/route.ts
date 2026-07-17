/**
 * Questionnaire next-question preview (F4.1).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/next-question
 *   body: {
 *     answered?:        { key: string; confidence?: number | null }[]
 *     recentMessages?:  string[]          // newest last; only `adaptive` reads these
 *     round?:           number            // defaults to the answered count
 *     sessionId?:       string            // seeds `random`; defaults per-version
 *     strategyOverride?: SelectionStrategy // preview a strategy other than the saved one
 *   }
 *
 *   Admin-only. Runs the version's configured selection strategy (or an override)
 *   against a hand-supplied answer state and returns what it would ask next. A
 *   read-only *preview* — it persists nothing, because the session/turn tables
 *   don't exist yet (F4.6/P6). Its purpose is twofold: give admins a way to sanity
 *   check their strategy choice before launch, and give the engine (P6) a proven
 *   selection seam to call.
 *
 *   The three deterministic strategies run as pure functions (no sub-cap; they
 *   inherit the section 100/min). `adaptive` runs its real embedding + LLM pick
 *   only when the `APP_QUESTIONNAIRES_ADAPTIVE_STRATEGY_ENABLED` sub-flag is on;
 *   that path takes a tighter per-admin sub-cap. When the sub-flag is off, an
 *   `adaptive` selection degrades to `weighted` (no deps wired → the strategy's
 *   own fallback). 404 when the master flag is off or the version is absent.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { SELECTION_STRATEGIES } from '@/lib/app/questionnaire/types';
import { getStrategy, type StrategyDeps } from '@/lib/app/questionnaire/selection';
import { buildSelectionContext } from '@/app/api/v1/app/questionnaires/_lib/selection-context';
import { buildAdaptiveDeps } from '@/app/api/v1/app/questionnaires/_lib/adaptive-deps';
import { adaptiveSelectionLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({
  answered: z
    .array(
      z.object({
        key: z.string().min(1),
        confidence: z.number().min(0).max(1).nullable().optional(),
      })
    )
    .max(1000)
    .default([]),
  recentMessages: z.array(z.string()).max(50).optional(),
  round: z.number().int().nonnegative().optional(),
  sessionId: z.string().min(1).max(200).optional(),
  strategyOverride: z.enum(SELECTION_STRATEGIES).optional(),
});

const handleNextQuestion = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const body = await validateRequestBody(request, bodySchema);

    const built = await buildSelectionContext(id, vid, {
      answered: body.answered,
      ...(body.recentMessages ? { recentMessages: body.recentMessages } : {}),
      ...(body.round !== undefined ? { round: body.round } : {}),
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
    });
    if (!built) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const { context, byId } = built;
    const strategySlug = body.strategyOverride ?? context.config.selectionStrategy;

    // Adaptive's real embedding + LLM path takes a per-admin sub-cap.
    let deps: StrategyDeps | undefined;
    if (strategySlug === 'adaptive') {
      const rl = adaptiveSelectionLimiter.check(adminId);
      if (!rl.success) {
        log.warn('Adaptive selection rate limit exceeded', { adminId, reset: rl.reset });
        return createRateLimitResponse(rl);
      }
      deps = buildAdaptiveDeps({ userId: adminId });
    }

    const decision = await getStrategy(strategySlug).select(context, deps);

    const chosen = decision.kind === 'ask' ? byId.get(decision.questionId) : undefined;

    log.info('Questionnaire next-question preview', {
      questionnaireId: id,
      versionId: vid,
      strategy: strategySlug,
      decisionKind: decision.kind,
      answeredCount: context.answered.length,
      ...(chosen ? { chosenKey: chosen.key } : {}),
    });

    return successResponse({
      strategy: strategySlug,
      decision,
      ...(chosen
        ? { question: { id: chosen.id, key: chosen.key, prompt: chosen.prompt ?? null } }
        : {}),
    });
  }
);

export const POST = handleNextQuestion;
