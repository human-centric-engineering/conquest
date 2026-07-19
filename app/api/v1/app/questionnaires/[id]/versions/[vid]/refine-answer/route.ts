/**
 * Questionnaire answer-refinement (F4.4).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/refine-answer
 *   body: {
 *     existingAnswers: {                          // ≥1
 *       key: string; value: unknown;
 *       provenance: AnswerProvenance;
 *       rationale?: string; confidence?: number | null; turnIndex?: number
 *     }[]
 *     userMessage?: string                         // the respondent's new message
 *     triggeringContradiction?: {                  // the F4.3 → F4.4 handoff
 *       slotKeys: string[]; explanation: string; suggestedProbe?: string
 *     }
 *   }
 *
 *   Admin-only. Runs the answer-refiner capability against a hand-supplied set of
 *   existing answers plus new context, and — unlike the F4.2/F4.3 preview routes —
 *   PERSISTS the result: it seeds the supplied answers into a per-version **preview
 *   session** (`isPreview`, excluded from P8 analytics), then applies each refine/
 *   overwrite decision via the pure `applyRefinement` and writes the new value,
 *   provenance, and appended `refinementHistory` back through `_lib/answer-slots.ts`.
 *   This exercises the real write path before the streaming engine (F4.6) exists.
 *
 *   404 when the version is absent. It spends an LLM call per pass, so the call
 *   takes a per-admin LLM sub-cap. Refinement failure is fail-soft — empty decisions
 *   with a `diagnostic`, never a 5xx (the seeded answers may already be persisted;
 *   the upsert is idempotent).
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import {
  QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
  REFINE_ANSWER_CAPABILITY_SLUG,
} from '@/lib/app/questionnaire/constants';
import { ANSWER_PROVENANCES } from '@/lib/app/questionnaire/types';
import {
  MAX_REFINEMENT_ANSWERS,
  type RefineAnswerData,
} from '@/lib/app/questionnaire/capabilities';
import { applyRefinement, summarizeRefinements } from '@/lib/app/questionnaire/refinement';
import { buildRefinementContext } from '@/app/api/v1/app/questionnaires/_lib/refinement-context';
import {
  getOrCreatePreviewSession,
  loadAnswerSlot,
  persistRefinement,
  upsertAnswerSlot,
} from '@/app/api/v1/app/questionnaires/_lib/answer-slots';
import { answerRefinementLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({
  existingAnswers: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.unknown(),
        provenance: z.enum(ANSWER_PROVENANCES),
        rationale: z.string().max(2_000).optional(),
        confidence: z.number().min(0).max(1).nullable().optional(),
        turnIndex: z.number().int().optional(),
      })
    )
    .min(1)
    // Aligned to the capability's MAX_REFINEMENT_ANSWERS so an over-large body is a
    // clean 400 here, not a confusing fail-soft empty result at dispatch.
    .max(MAX_REFINEMENT_ANSWERS),
  userMessage: z.string().max(10_000).optional(),
  triggeringContradiction: z
    .object({
      slotKeys: z.array(z.string()),
      explanation: z.string(),
      suggestedProbe: z.string().optional(),
    })
    .optional(),
});

const handleRefineAnswer = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const body = await validateRequestBody(request, bodySchema);

    // Per-admin sub-cap on the paid LLM call. Checked before the DB work and dispatch.
    const rl = answerRefinementLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Answer refinement rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const built = await buildRefinementContext(id, vid, {
      existingAnswers: body.existingAnswers,
      ...(body.userMessage !== undefined ? { userMessage: body.userMessage } : {}),
      ...(body.triggeringContradiction !== undefined
        ? { triggeringContradiction: body.triggeringContradiction }
        : {}),
    });
    if (!built.ok) {
      if (built.reason === 'version_not_found') {
        throw new NotFoundError('Questionnaire version not found');
      }
      // No supplied answer resolves to a real slot — nothing to refine.
      throw new ValidationError('At least one answer must reference a question in this version');
    }

    const { context } = built;

    // slotKey → AppQuestionSlot.id, for seeding and persisting answer rows.
    const slotIdByKey = new Map<string, string>();
    for (const slot of context.slots) {
      if (slot.id) slotIdByKey.set(slot.key, slot.id);
    }

    // Seed the supplied existing answers into the per-version preview session so the
    // refinement has real rows to write back to (idempotent upsert).
    const sessionId = await getOrCreatePreviewSession(vid);
    for (const answer of context.existingAnswers) {
      const slotId = slotIdByKey.get(answer.slotKey);
      if (!slotId) continue;
      await upsertAnswerSlot(sessionId, slotId, {
        value: answer.value,
        provenance: answer.provenance,
        ...(answer.rationale !== undefined ? { rationale: answer.rationale } : {}),
        ...(answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
      });
    }

    // Load the refiner agent for cost attribution + the provider-agnostic binding.
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      log.error('Answer-refiner agent not found; run db:seed', {
        slug: QUESTIONNAIRE_ANSWER_REFINER_AGENT_SLUG,
      });
      throw new NotFoundError('Answer refinement is not configured');
    }

    // Flush capability handlers before dispatch — this route may be the first capability touch
    // on a fresh process (the dispatcher does not lazy-register). Idempotent, one-shot.
    registerBuiltInCapabilities();

    const dispatch = await capabilityDispatcher.dispatch(
      REFINE_ANSWER_CAPABILITY_SLUG,
      {
        slots: context.slots,
        existingAnswers: context.existingAnswers,
        sessionId,
        ...(context.userMessage !== undefined ? { userMessage: context.userMessage } : {}),
        ...(context.triggeringContradiction !== undefined
          ? { triggeringContradiction: context.triggeringContradiction }
          : {}),
      },
      {
        userId: adminId,
        agentId: agent.id,
        entityContext: {
          answerRefinerAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );

    // Fail-soft: a failed refinement pass must not 5xx the conversation. Return empty
    // decisions with a diagnostic so the engine (F4.6) can continue. The seeded
    // answers may already be persisted — that's fine (idempotent upsert).
    if (!dispatch.success || !dispatch.data) {
      log.warn('Answer refinement failed; returning empty decisions', {
        questionnaireId: id,
        versionId: vid,
        code: dispatch.error?.code,
      });
      return successResponse({
        decisions: [],
        persistedSlots: [],
        summary: summarizeRefinements([], 0),
        diagnostic: dispatch.error?.code ?? 'refinement_failed',
      });
    }

    const { decisions, droppedCount } = dispatch.data as RefineAnswerData;

    // Apply + persist each decision: load the (just-seeded) row, merge via the pure
    // applyRefinement, write the new value/provenance/history back.
    const persistedSlots: Array<{
      slotKey: string;
      value: unknown;
      provenance: string;
      action: string;
    }> = [];
    for (const decision of decisions) {
      const slotId = slotIdByKey.get(decision.slotKey);
      if (!slotId) continue;
      const loaded = await loadAnswerSlot(sessionId, slotId);
      if (!loaded) continue;
      const refined = applyRefinement(loaded.existing, decision);
      await persistRefinement(loaded.id, refined);
      persistedSlots.push({
        slotKey: refined.slotKey,
        value: refined.value,
        provenance: refined.provenance,
        action: decision.action,
      });
    }

    const summary = summarizeRefinements(decisions, droppedCount);

    log.info('Questionnaire answer-refinement', {
      questionnaireId: id,
      versionId: vid,
      sessionId,
      refineCount: summary.refineCount,
      overwriteCount: summary.overwriteCount,
      persistedCount: persistedSlots.length,
      droppedCount,
    });

    return successResponse({ decisions, persistedSlots, summary });
  }
);

export const POST = handleRefineAnswer;
