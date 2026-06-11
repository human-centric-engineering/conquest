/**
 * Questionnaire contradiction-detection preview (F4.3).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/detect-contradictions
 *   body: {
 *     answers: { key: string; value: unknown; confidence?: number | null;
 *                provenance?: AnswerProvenance; turnIndex?: number }[]   // ≥2
 *     mode?:    'off' | 'flag' | 'probe'   // defaults to the version's config
 *     windowN?: number                     // defaults to the version's config
 *     sessionId?: string
 *   }
 *
 *   Admin-only. Runs the contradiction-detector capability against a hand-supplied
 *   set of answers and returns the conflicts it would surface — which slots
 *   contradict, why, a severity, and (under `probe` mode) a follow-up question. A
 *   read-only *preview*: it persists nothing and overwrites nothing (resolution is
 *   F4.4, persistence F4.6). Its purpose is twofold — let admins sanity-check
 *   detection (and compare `flag` vs `probe`) before launch, and give the engine
 *   (P6) a proven detection seam to call.
 *
 *   Gated by the master flag AND the contradiction-detection sub-flag (it spends an
 *   LLM call per pass): 404 when either is off, or when the version is absent. The
 *   call takes a per-admin LLM sub-cap. Detection failure is fail-soft — an empty
 *   findings list with a `diagnostic`, never a 5xx — so the engine can keep the
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
  isContradictionDetectionEnabled,
  withQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
  QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import { ANSWER_PROVENANCES, CONTRADICTION_MODES } from '@/lib/app/questionnaire/types';
import {
  MAX_CONTRADICTION_ANSWERS,
  type DetectContradictionsData,
} from '@/lib/app/questionnaire/capabilities';
import { summarizeFindings } from '@/lib/app/questionnaire/contradiction';
import { buildContradictionContext } from '@/app/api/v1/app/questionnaires/_lib/contradiction-context';
import { contradictionDetectionLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({
  answers: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.unknown(),
        confidence: z.number().min(0).max(1).nullable().optional(),
        provenance: z.enum(ANSWER_PROVENANCES).optional(),
        turnIndex: z.number().int().optional(),
      })
    )
    .min(2)
    // Aligned to the capability's MAX_CONTRADICTION_ANSWERS so an over-large body is
    // a clean 400 here, not a confusing fail-soft "no contradictions" at dispatch.
    .max(MAX_CONTRADICTION_ANSWERS),
  mode: z.enum(CONTRADICTION_MODES).optional(),
  windowN: z.number().int().min(0).max(10_000).optional(),
  sessionId: z.string().max(200).optional(),
});

const handleDetectContradictions = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    // Sub-flag gate: detection always spends an LLM call, so it's opt-in on top of
    // the master flag. Off → 404 (a disabled sub-feature looks like a missing
    // route, consistent with the master gate).
    if (!(await isContradictionDetectionEnabled())) {
      throw new NotFoundError('Questionnaire contradiction detection is not enabled');
    }

    const body = await validateRequestBody(request, bodySchema);

    // Per-admin sub-cap on the paid LLM call (the section 100/min is too loose for a
    // per-pass completion). Checked before the DB work and the dispatch.
    const rl = contradictionDetectionLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Contradiction detection rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const built = await buildContradictionContext(id, vid, {
      answers: body.answers,
      ...(body.mode !== undefined ? { mode: body.mode } : {}),
      ...(body.windowN !== undefined ? { windowN: body.windowN } : {}),
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
    });
    if (!built.ok) {
      if (built.reason === 'version_not_found') {
        throw new NotFoundError('Questionnaire version not found');
      }
      // Fewer than two supplied answers resolve to real slots — nothing can
      // contradict, so it's a bad request, not a missing resource.
      throw new ValidationError('At least two answers must reference questions in this version');
    }

    const { context } = built;

    // Load the detector agent for cost attribution + the provider-agnostic binding
    // the capability resolves from the dispatch context.
    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      // A seeded agent is missing — a config problem, not a per-pass failure.
      log.error('Contradiction-detector agent not found; run db:seed', {
        slug: QUESTIONNAIRE_CONTRADICTION_DETECTOR_AGENT_SLUG,
      });
      throw new NotFoundError('Contradiction detection is not configured');
    }

    // Flush capability handlers before dispatch — this route may be the first capability touch
    // on a fresh process (the dispatcher does not lazy-register). Idempotent, one-shot.
    registerBuiltInCapabilities();

    const dispatch = await capabilityDispatcher.dispatch(
      DETECT_CONTRADICTIONS_CAPABILITY_SLUG,
      {
        slots: context.slots,
        answers: context.answers,
        mode: context.mode,
        windowN: context.windowN,
        sessionId: context.sessionId,
      },
      {
        userId: adminId,
        agentId: agent.id,
        entityContext: {
          contradictionDetectorAgent: {
            provider: agent.provider,
            model: agent.model,
            fallbackProviders: agent.fallbackProviders,
          },
        },
      }
    );

    // Fail-soft: detection has no deterministic fallback, but a failed pass must not
    // 5xx the conversation. Return an empty findings list with a diagnostic so the
    // engine (F4.6) can continue rather than crash.
    if (!dispatch.success || !dispatch.data) {
      log.warn('Contradiction detection failed; returning empty findings', {
        questionnaireId: id,
        versionId: vid,
        code: dispatch.error?.code,
      });
      return successResponse({
        findings: [],
        summary: summarizeFindings([], 0),
        diagnostic: dispatch.error?.code ?? 'detection_failed',
      });
    }

    const { findings, droppedCount } = dispatch.data as DetectContradictionsData;
    // One roll-up shared with the capability's audit preview (drift-proof). The
    // `droppedCount` is the real number the capability discarded (unknown/unanswered
    // slot, <2 distinct, duplicate) — non-zero means the model produced more than `findings`.
    const summary = summarizeFindings(findings, droppedCount);

    log.info('Questionnaire contradiction-detection preview', {
      questionnaireId: id,
      versionId: vid,
      mode: context.mode,
      findingCount: summary.findingCount,
      probeCount: summary.probeCount,
      droppedCount,
    });

    return successResponse({ findings, summary });
  }
);

export const POST = withQuestionnairesEnabled(handleDetectContradictions);
