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
 *   404 when the version is absent. The whole route is paid LLM work — there is no free
 *   deterministic result to fall back to — so the run takes a per-admin LLM sub-cap.
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
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
  type EvaluationDimension,
} from '@/lib/app/questionnaire/evaluation';
import { runEvaluationPanel } from '@/lib/app/questionnaire/evaluation/run-panel';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import { designEvaluationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const bodySchema = z.object({
  /** Which dimensions to run; defaults to the whole panel. Deduped at use. */
  dimensions: z.array(z.enum(EVALUATION_DIMENSIONS)).max(EVALUATION_DIMENSIONS.length).optional(),
});

const handleEvaluatePreview = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

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

    // Dispatch the panel via the shared service — fail-soft per judge (a missing agent or
    // a failed/throwing dispatch degrades to a `diagnostic` for that one dimension while
    // the others still return). The F5.2 run route shares this exact dispatch and then
    // persists the result; the preview returns it ephemerally.
    const { results, summary } = await runEvaluationPanel({
      dimensions,
      structure,
      questionnaireId: id,
      versionId: vid,
      agentBySlug,
      adminId,
      log,
    });

    log.info('Questionnaire design-evaluation preview', {
      questionnaireId: id,
      versionId: vid,
      ...summary,
    });

    return successResponse({ results, summary });
  }
);

export const POST = handleEvaluatePreview;
