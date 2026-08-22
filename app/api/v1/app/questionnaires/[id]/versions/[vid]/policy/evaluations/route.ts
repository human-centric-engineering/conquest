/**
 * Interviewer-policy evaluation runs (F18.8).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/policy/evaluations
 *   body: { dimensions?: PolicyEvaluationDimension[] }   // default: all four
 *
 *   Admin-only. Runs the policy-judge panel over a version's authored interviewer policy (the
 *   shared dispatch seam — one structured LLM call per dimension, fail-soft per judge), then
 *   PERSISTS the run + one finding row per judge finding and returns the completed run detail.
 *   Synchronous, like the design-evaluation panel: no worker, no polling. The whole POST is paid
 *   LLM work, so it takes the per-admin LLM sub-cap.
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/policy/evaluations
 *   Admin-only. Lists this version's persisted policy-evaluation runs newest-first (paginated).
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
  POLICY_EVALUATION_DIMENSIONS,
  POLICY_EVALUATION_DIMENSION_SPECS,
  type PolicyEvaluationDimension,
} from '@/lib/app/questionnaire/policy-evaluation';
// Imported from its own leaf, not the barrel above — see that barrel's comment on why
// `run-panel.ts` (it imports the capability dispatcher → Prisma) is never re-exported there.
import { runPolicyEvaluationPanel } from '@/lib/app/questionnaire/policy-evaluation/run-panel';
import { buildPolicyEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-structure';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { policyEvaluationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  listPolicyEvaluationRuns,
  persistPolicyEvaluationRun,
} from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-run-routes';

/**
 * Wall-clock ceiling — same reasoning as the evaluate-preview route: four judges fan out
 * concurrently, so the run costs one slow judge at worst (180s), and there is no reconcile step.
 */
export const maxDuration = 300;

const bodySchema = z.object({
  dimensions: z
    .array(z.enum(POLICY_EVALUATION_DIMENSIONS))
    .max(POLICY_EVALUATION_DIMENSIONS.length)
    .optional(),
});

const handleCreateRun = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const body = await validateRequestBody(request, bodySchema);
    const dimensions: PolicyEvaluationDimension[] =
      body.dimensions && body.dimensions.length > 0
        ? [...new Set(body.dimensions)]
        : [...POLICY_EVALUATION_DIMENSIONS];

    const rl = policyEvaluationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Policy-evaluation rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const structure = await buildPolicyEvaluationStructure(id, vid);
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const wantedSlugs = dimensions.map((d) => POLICY_EVALUATION_DIMENSION_SPECS[d].slug);
    const agents = await prisma.aiAgent.findMany({
      where: { slug: { in: wantedSlugs }, kind: 'judge' },
      select: { slug: true, id: true, provider: true, model: true, fallbackProviders: true },
    });
    const agentBySlug = new Map(agents.map((a) => [a.slug, a]));

    if (wantedSlugs.every((slug) => !agentBySlug.has(slug))) {
      log.error('No policy-evaluation judge agents found; run db:seed', { wantedSlugs });
      throw new NotFoundError('Interviewer-policy evaluation is not configured');
    }

    const startedAt = new Date();
    const panel = await runPolicyEvaluationPanel({
      dimensions,
      structure,
      questionnaireId: id,
      versionId: vid,
      agentBySlug,
      adminId,
      log,
    });
    const completedAt = new Date();

    const run = await persistPolicyEvaluationRun({
      questionnaireId: id,
      versionId: vid,
      triggeredByUserId: adminId,
      panel,
      structure,
      startedAt,
      completedAt,
    });

    log.info('Interviewer-policy evaluation run persisted', {
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

    const { runs, total } = await listPolicyEvaluationRuns(vid, { skip, limit });
    log.info('Interviewer-policy evaluation runs listed', {
      versionId: vid,
      count: runs.length,
      total,
    });

    return paginatedResponse(runs, { page, limit, total });
  }
);

export const POST = handleCreateRun;
export const GET = handleListRuns;
