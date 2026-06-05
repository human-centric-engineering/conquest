/**
 * Design-time evaluation preview (F5.1).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/evaluate-preview
 *   body: { dimensions?: EvaluationDimension[] }   // default: all seven
 *
 *   Admin-only. Runs the judge panel over a version's authored structure — one
 *   structured LLM call per dimension — and returns each judge's verdict (a score in
 *   [0, 1] plus actionable findings). A read-only *preview*: it persists nothing,
 *   because the run + suggestion tables are F5.2 and the review queue is F5.3. Its
 *   purpose is to let admins tune the panel and sanity-check a structure before launch,
 *   and to give F5.2 a proven dispatch seam to build persistence on.
 *
 *   Gated by the master flag AND the design-evaluation sub-flag (the whole route is
 *   paid LLM work — there is no free deterministic result to fall back to): 404 when
 *   either is off, or when the version is absent. The run takes a per-admin LLM sub-cap.
 *   Per-judge failure is fail-soft — a dimension that errors returns a `diagnostic`
 *   instead of a verdict, and the other six still return — so one flaky judge never
 *   5xxs the whole panel.
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
import {
  isDesignEvaluationEnabled,
  withQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import { EVALUATE_STRUCTURE_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
  type EvaluationDimension,
  type JudgeVerdict,
} from '@/lib/app/questionnaire/evaluation';
import type { EvaluateStructureData } from '@/lib/app/questionnaire/capabilities';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import { designEvaluationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({
  /** Which dimensions to run; defaults to the whole panel. Deduped at use. */
  dimensions: z.array(z.enum(EVALUATION_DIMENSIONS)).max(EVALUATION_DIMENSIONS.length).optional(),
});

/** One dimension's outcome: a verdict, or a diagnostic when its judge failed/was absent. */
interface DimensionResult {
  dimension: EvaluationDimension;
  verdict?: JudgeVerdict;
  diagnostic?: string;
}

const handleEvaluatePreview = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    // Sub-flag gate: the panel always spends seven LLM calls, so it's opt-in on top
    // of the master flag. Off → 404 (a disabled sub-feature looks like a missing
    // route). Unlike completion, there is no free deterministic half to return.
    if (!(await isDesignEvaluationEnabled())) {
      throw new NotFoundError('Questionnaire design-time evaluation is not enabled');
    }

    const body = await validateRequestBody(request, bodySchema);
    const dimensions: EvaluationDimension[] =
      body.dimensions && body.dimensions.length > 0
        ? [...new Set(body.dimensions)]
        : [...EVALUATION_DIMENSIONS];

    // Per-admin sub-cap on the paid panel (the section 100/min is far too loose for a
    // seven-call fan-out). Checked before the DB work and the dispatch.
    const rl = designEvaluationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Design-evaluation rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const structure = await buildEvaluationStructure(id, vid);
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found');
    }

    // Load the judge agents for the requested dimensions in one query — each carries
    // the provider-agnostic binding the capability resolves from the dispatch context.
    const wantedSlugs = dimensions.map((d) => EVALUATION_DIMENSION_SPECS[d].slug);
    const agents = await prisma.aiAgent.findMany({
      where: { slug: { in: wantedSlugs }, kind: 'judge' },
      select: { slug: true, id: true, provider: true, model: true, fallbackProviders: true },
    });
    const agentBySlug = new Map(agents.map((a) => [a.slug, a]));

    // Every judge missing means the seed never ran — a config problem, not a per-run
    // failure. A subset missing is fail-soft per dimension below.
    if (agentBySlug.size === 0) {
      log.error('No design-evaluation judge agents found; run db:seed', { wantedSlugs });
      throw new NotFoundError('Questionnaire design-time evaluation is not configured');
    }

    // Dispatch the panel concurrently. Per-judge failure is fail-soft: a missing agent
    // or a failed call yields a `diagnostic` for that dimension, never a thrown error,
    // so one flaky judge can't sink the other six.
    const results: DimensionResult[] = await Promise.all(
      dimensions.map(async (dimension): Promise<DimensionResult> => {
        const agent = agentBySlug.get(EVALUATION_DIMENSION_SPECS[dimension].slug);
        if (!agent) {
          log.warn('Judge agent missing for dimension; skipping', { dimension });
          return { dimension, diagnostic: 'judge_not_configured' };
        }

        // The dispatcher represents capability failures as a `{ success: false }`
        // envelope, but it can still THROW on an infrastructure fault (e.g. the
        // registry DB load inside `dispatch` failing) — and because the panel fans
        // out under one `Promise.all`, an unguarded throw would reject the whole
        // request and 5xx all seven dimensions. Wrap the dispatch so any throw
        // degrades to this dimension's diagnostic, keeping the fail-soft contract
        // literally true even for unexpected faults.
        let dispatch;
        try {
          dispatch = await capabilityDispatcher.dispatch(
            EVALUATE_STRUCTURE_CAPABILITY_SLUG,
            { dimension, structure, versionId: vid },
            {
              userId: adminId,
              agentId: agent.id,
              entityContext: {
                judgeAgent: {
                  provider: agent.provider,
                  model: agent.model,
                  fallbackProviders: agent.fallbackProviders,
                },
              },
            }
          );
        } catch (err) {
          log.error('Judge dispatch threw; returning diagnostic for dimension', {
            questionnaireId: id,
            versionId: vid,
            dimension,
            error: err instanceof Error ? err.message : String(err),
          });
          return { dimension, diagnostic: 'dispatch_error' };
        }

        if (dispatch.success && dispatch.data) {
          return { dimension, verdict: (dispatch.data as EvaluateStructureData).verdict };
        }
        log.warn('Judge dispatch failed; returning diagnostic for dimension', {
          questionnaireId: id,
          versionId: vid,
          dimension,
          code: dispatch.error?.code,
        });
        return { dimension, diagnostic: dispatch.error?.code ?? 'evaluation_failed' };
      })
    );

    const dimensionsRun = results.filter((r) => r.verdict !== undefined).length;
    const totalFindings = results.reduce((sum, r) => sum + (r.verdict?.findings.length ?? 0), 0);

    log.info('Questionnaire design-evaluation preview', {
      questionnaireId: id,
      versionId: vid,
      dimensionsRequested: dimensions.length,
      dimensionsRun,
      dimensionsFailed: dimensions.length - dimensionsRun,
      totalFindings,
    });

    return successResponse({
      results,
      summary: {
        dimensionsRequested: dimensions.length,
        dimensionsRun,
        dimensionsFailed: dimensions.length - dimensionsRun,
        totalFindings,
      },
    });
  }
);

export const POST = withQuestionnairesEnabled(handleEvaluatePreview);
