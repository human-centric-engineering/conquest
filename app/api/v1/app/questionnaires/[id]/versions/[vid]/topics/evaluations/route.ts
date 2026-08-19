/**
 * Adaptive Scope evaluation runs (F17.21).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/topics/evaluations
 *   body: { dimensions?: ScopeEvaluationDimension[] }   // default: all four
 *
 *   Admin-only. Runs the scope-judge panel over a version's authored Adaptive Scope config (the
 *   shared dispatch seam — one structured LLM call per dimension, fail-soft per judge), then
 *   PERSISTS the run + one finding row per judge finding and returns the completed run detail.
 *   Synchronous, like the design-evaluation panel: no worker, no polling. The whole POST is paid
 *   LLM work, so it takes the per-admin LLM sub-cap.
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/topics/evaluations
 *   Admin-only. Lists this version's persisted scope-evaluation runs newest-first (paginated).
 *   Read-only and version-scoped via `loadScopedVersion`.
 */

import { z } from 'zod';

import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { parsePaginationParams, validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import {
  SCOPE_EVALUATION_DIMENSIONS,
  SCOPE_EVALUATION_DIMENSION_SPECS,
  type ScopeEvaluationDimension,
} from '@/lib/app/questionnaire/scope-evaluation';
// Imported from its own leaf, not the barrel above — see that barrel's comment on why
// `run-panel.ts` (it imports the capability dispatcher → Prisma) is never re-exported there.
import { runScopeEvaluationPanel } from '@/lib/app/questionnaire/scope-evaluation/run-panel';
import { buildScopeEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/scope-evaluation-structure';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { scopeEvaluationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  listScopeEvaluationRuns,
  persistScopeEvaluationRun,
} from '@/app/api/v1/app/questionnaires/_lib/scope-evaluation-run-routes';

/**
 * Wall-clock ceiling — same reasoning as the evaluate-preview route: four judges fan out
 * concurrently, so the run costs one slow judge at worst (180s), and there is no reconcile step.
 */
export const maxDuration = 300;

const bodySchema = z.object({
  dimensions: z
    .array(z.enum(SCOPE_EVALUATION_DIMENSIONS))
    .max(SCOPE_EVALUATION_DIMENSIONS.length)
    .optional(),
});

const handleCreateRun = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const body = await validateRequestBody(request, bodySchema);
    const dimensions: ScopeEvaluationDimension[] =
      body.dimensions && body.dimensions.length > 0
        ? [...new Set(body.dimensions)]
        : [...SCOPE_EVALUATION_DIMENSIONS];

    const rl = scopeEvaluationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Scope-evaluation rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const structure = await buildScopeEvaluationStructure(id, vid);
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const wantedSlugs = dimensions.map((d) => SCOPE_EVALUATION_DIMENSION_SPECS[d].slug);
    const agents = await prisma.aiAgent.findMany({
      where: { slug: { in: wantedSlugs }, kind: 'judge' },
      select: { slug: true, id: true, provider: true, model: true, fallbackProviders: true },
    });
    const agentBySlug = new Map(agents.map((a) => [a.slug, a]));

    if (wantedSlugs.every((slug) => !agentBySlug.has(slug))) {
      log.error('No scope-evaluation judge agents found; run db:seed', { wantedSlugs });
      throw new NotFoundError('Adaptive Scope evaluation is not configured');
    }

    const startedAt = new Date();
    const panel = await runScopeEvaluationPanel({
      dimensions,
      structure,
      questionnaireId: id,
      versionId: vid,
      agentBySlug,
      adminId,
      log,
    });
    const completedAt = new Date();

    const run = await persistScopeEvaluationRun({
      questionnaireId: id,
      versionId: vid,
      triggeredByUserId: adminId,
      panel,
      structure,
      startedAt,
      completedAt,
    });

    log.info('Adaptive Scope evaluation run persisted', {
      questionnaireId: id,
      versionId: vid,
      runId: run.id,
      status: run.status,
      ...panel.summary,
    });

    return successResponse(run);
  }
);

const handleListRuns = withAdminAuth<{ id: string; vid: string }>(
  async (request, _session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const { searchParams } = new URL(request.url);
    const { page, limit, skip } = parsePaginationParams(searchParams);

    const { runs, total } = await listScopeEvaluationRuns(vid, { skip, limit });
    log.info('Adaptive Scope evaluation runs listed', {
      versionId: vid,
      count: runs.length,
      total,
    });

    return paginatedResponse(runs, { page, limit, total });
  }
);

export const POST = handleCreateRun;
export const GET = handleListRuns;
