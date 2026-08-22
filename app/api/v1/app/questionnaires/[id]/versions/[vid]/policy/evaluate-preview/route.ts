/**
 * Interviewer-policy evaluation preview (F18.8).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/policy/evaluate-preview
 *   body: { dimensions?: PolicyEvaluationDimension[] }   // default: all four
 *
 *   Admin-only. Runs the interviewer-policy judge panel over a version's authored house rules,
 *   questioning arc and per-question fidelity dial — one structured LLM call per dimension — and
 *   returns each judge's verdict (a score in [0, 1] plus actionable findings). A read-only
 *   *preview*: it persists nothing, mirroring the first phase of both sibling panels.
 *
 *   **409 for a form-only questionnaire, before any dispatch.** `presentationMode: 'form'` means the
 *   interviewer never runs, so the entire policy layer is inert — and the mechanical conflict
 *   checker already says so four different ways. Paying for four LLM calls to be told the
 *   conversation does not exist is the kind of waste that reaches a bill.
 *
 *   404 when the version is absent. The whole route is paid LLM work with no free deterministic
 *   fallback, so it takes a per-admin LLM sub-cap. Per-judge failure is fail-soft — a dimension that
 *   errors returns a `diagnostic` instead of a verdict and the other three still return — so one
 *   flaky judge never 5xxs the panel.
 */

import { z } from 'zod';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import {
  POLICY_EVALUATION_DIMENSIONS,
  POLICY_EVALUATION_DIMENSION_SPECS,
  type PolicyEvaluationDimension,
} from '@/lib/app/questionnaire/policy-evaluation';
// Imported from its own leaf, not the barrel above — see that barrel's comment on why
// `run-panel.ts` (it imports the capability dispatcher → Prisma) is never re-exported there.
import { runPolicyEvaluationPanel } from '@/lib/app/questionnaire/policy-evaluation/run-panel';
import { buildPolicyEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-structure';
import { policyEvaluationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/**
 * Wall-clock ceiling for the whole panel — same number and same reasoning as both sibling preview
 * routes: four judges fan out concurrently, so the run costs one slow judge at worst (a reasoning
 * model, retried once at a fresh 90s timeout), i.e. 180s — past the platform's 60s default.
 */
export const maxDuration = 300;

const bodySchema = z.object({
  /** Which dimensions to run; defaults to the whole panel. Deduped at use. */
  dimensions: z
    .array(z.enum(POLICY_EVALUATION_DIMENSIONS))
    .max(POLICY_EVALUATION_DIMENSIONS.length)
    .optional(),
});

const handleEvaluatePolicyPreview = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const body = await validateRequestBody(request, bodySchema);
    const dimensions: PolicyEvaluationDimension[] =
      body.dimensions && body.dimensions.length > 0
        ? [...new Set(body.dimensions)]
        : [...POLICY_EVALUATION_DIMENSIONS];

    // Per-admin sub-cap on the paid panel, checked before the DB work and the dispatch.
    const rl = policyEvaluationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Policy-evaluation rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const structure = await buildPolicyEvaluationStructure(id, vid);
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found');
    }

    // The interviewer never runs on a form-only questionnaire, so there is no policy to judge.
    // Refused before dispatch rather than after — four paid calls to learn this would be waste.
    if (structure.context.presentationMode === 'form') {
      log.info('Policy evaluation skipped: form-only questionnaire', {
        questionnaireId: id,
        versionId: vid,
      });
      return errorResponse(
        'This questionnaire has no conversation, so there is no policy to judge',
        {
          code: 'PRESENTATION_FORM_ONLY',
          status: 409,
        }
      );
    }

    // Load the judge agents for the requested dimensions in one query — each carries the
    // provider-agnostic binding the capability resolves from the dispatch context.
    const wantedSlugs = dimensions.map((d) => POLICY_EVALUATION_DIMENSION_SPECS[d].slug);
    const agents = await prisma.aiAgent.findMany({
      where: { slug: { in: wantedSlugs }, kind: 'judge' },
      select: { slug: true, id: true, provider: true, model: true, fallbackProviders: true },
    });
    const agentBySlug = new Map(agents.map((a) => [a.slug, a]));

    // Every judge missing means the seed never ran — a config problem, not a per-run failure. A
    // subset missing is fail-soft per dimension inside the panel.
    if (wantedSlugs.every((slug) => !agentBySlug.has(slug))) {
      log.error('No policy-evaluation judge agents found; run db:seed', { wantedSlugs });
      throw new NotFoundError('Interviewer-policy evaluation is not configured');
    }

    const { results, summary } = await runPolicyEvaluationPanel({
      dimensions,
      structure,
      questionnaireId: id,
      versionId: vid,
      agentBySlug,
      adminId,
      log,
    });

    log.info('Interviewer-policy evaluation preview', {
      questionnaireId: id,
      versionId: vid,
      ...summary,
    });

    return successResponse({ results, summary });
  }
);

export const POST = handleEvaluatePolicyPreview;
