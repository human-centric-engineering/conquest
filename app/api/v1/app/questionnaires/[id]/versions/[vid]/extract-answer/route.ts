/**
 * Questionnaire answer-extraction preview (F4.2).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/extract-answer
 *   body: {
 *     activeQuestionKey: string          // the question being asked
 *     userMessage:       string          // the respondent's reply
 *     answered?:         { key: string; confidence?: number | null }[]
 *     recentMessages?:   string[]        // oldest → newest, for disambiguation
 *   }
 *
 *   Admin-only. Runs the answer-extractor capability against a hand-supplied turn
 *   and returns the per-slot intents it would record — the active question plus
 *   any side-effects (other slots the same message answers). A read-only
 *   *preview*: it persists nothing, because the session/answer tables don't exist
 *   yet (F4.6/P6). Its purpose is twofold — let admins sanity-check extraction
 *   before launch, and give the engine (P6) a proven extraction seam to call.
 *
 *   Gated by the master flag AND the answer-extraction sub-flag (it spends an LLM
 *   call per turn): 404 when either is off, or when the version is absent. The
 *   call takes a per-admin LLM sub-cap. Extraction failure is fail-soft — an empty
 *   intent list with a `diagnostic`, never a 5xx — so the engine can keep the
 *   conversation going rather than crash a turn.
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
  isAnswerExtractionEnabled,
  withQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { ExtractAnswerSlotsData } from '@/lib/app/questionnaire/capabilities';
import { buildExtractionContext } from '@/app/api/v1/app/questionnaires/_lib/extraction-context';
import { answerExtractionLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({
  activeQuestionKey: z.string().min(1).max(200),
  userMessage: z.string().min(1).max(10_000),
  answered: z
    .array(
      z.object({
        key: z.string().min(1),
        confidence: z.number().min(0).max(1).nullable().optional(),
      })
    )
    .max(1000)
    .default([]),
  recentMessages: z.array(z.string().max(10_000)).max(50).optional(),
});

const handleExtractAnswer = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    // Sub-flag gate: extraction always spends an LLM call, so it's opt-in on top
    // of the master flag. Off → 404 (a disabled sub-feature looks like a missing
    // route, consistent with the master gate).
    if (!(await isAnswerExtractionEnabled())) {
      throw new NotFoundError('Questionnaire answer extraction is not enabled');
    }

    const body = await validateRequestBody(request, bodySchema);

    // Per-admin sub-cap on the paid LLM call (the section 100/min is too loose
    // for a per-turn completion). Checked before the DB work and the dispatch.
    const rl = answerExtractionLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Answer extraction rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const built = await buildExtractionContext(id, vid, {
      activeQuestionKey: body.activeQuestionKey,
      userMessage: body.userMessage,
      answered: body.answered,
      ...(body.recentMessages ? { recentMessages: body.recentMessages } : {}),
    });
    if (!built.ok) {
      if (built.reason === 'version_not_found') {
        throw new NotFoundError('Questionnaire version not found');
      }
      // The version exists but the active key isn't one of its slots — a bad
      // request, not a missing resource.
      throw new ValidationError('activeQuestionKey does not match any question in this version');
    }

    const { context } = built;

    // Load the answer-extractor agent for cost attribution + the provider-agnostic
    // binding the capability resolves from the dispatch context.
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      // A seeded agent is missing — a config problem, not a per-turn failure.
      log.error('Answer-extractor agent not found; run db:seed', {
        slug: QUESTIONNAIRE_ANSWER_EXTRACTOR_AGENT_SLUG,
      });
      throw new NotFoundError('Answer extraction is not configured');
    }

    // Flush capability handlers before dispatch — this route may be the first capability touch
    // on a fresh process (the dispatcher does not lazy-register). Idempotent, one-shot.
    registerBuiltInCapabilities();

    const dispatch = await capabilityDispatcher.dispatch(
      EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
      {
        userMessage: context.userMessage,
        activeQuestionKey: context.activeQuestionKey,
        candidateSlots: context.candidateSlots,
        answered: context.answered,
        ...(context.recentMessages ? { recentMessages: context.recentMessages } : {}),
        sessionId: context.sessionId,
      },
      {
        userId: adminId,
        agentId: agent.id,
        entityContext: {
          answerExtractorAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );

    // Fail-soft: extraction has no deterministic fallback, but a failed turn must
    // not 5xx the conversation. Return an empty intent list with a diagnostic so
    // the engine (F4.6) can ask the respondent to rephrase rather than crash.
    if (!dispatch.success || !dispatch.data) {
      log.warn('Answer extraction failed; returning empty intents', {
        questionnaireId: id,
        versionId: vid,
        code: dispatch.error?.code,
      });
      return successResponse({
        intents: [],
        summary: { activeAnswerCount: 0, sideEffectCount: 0, droppedCount: 0 },
        diagnostic: dispatch.error?.code ?? 'extraction_failed',
      });
    }

    const { intents, droppedCount } = dispatch.data as ExtractAnswerSlotsData;
    const activeAnswerCount = intents.filter((i) => i.isActiveQuestion).length;

    log.info('Questionnaire answer-extraction preview', {
      questionnaireId: id,
      versionId: vid,
      activeQuestionKey: context.activeQuestionKey,
      intentCount: intents.length,
      activeAnswerCount,
      droppedCount,
    });

    return successResponse({
      intents,
      summary: {
        activeAnswerCount,
        sideEffectCount: intents.length - activeAnswerCount,
        // The real count the capability discarded (unknown slot / bad value /
        // duplicate) — a non-zero value means the model produced more than `intents`.
        droppedCount,
      },
    });
  }
);

export const POST = withQuestionnairesEnabled(handleExtractAnswer);
