/**
 * Design-time evaluation runs (F5.2).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/evaluations
 *   body: { dimensions?: EvaluationDimension[] }   // default: all seven
 *
 *   Admin-only. Runs the judge panel over a version's authored structure (the shared
 *   F5.1 dispatch seam — one structured LLM call per dimension, fail-soft per judge),
 *   then PERSISTS the run + one finding row per judge finding and returns the completed
 *   run detail. Synchronous: the run is terminal the moment this returns (no worker, no
 *   polling — the 2026-06-05 decision). Gated by the master flag AND the design-evaluation
 *   sub-flag (the whole POST is paid LLM work — 404 when either is off, mirroring the
 *   preview route), and takes the per-admin LLM sub-cap.
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/evaluations
 *   Admin-only. Lists this version's persisted runs newest-first (paginated). Read-only —
 *   master-flag-gated and version-scoped via `loadScopedVersion`, with no sub-flag 404
 *   (persisted history stays readable even if the sub-feature is later switched off, the
 *   same posture as the read-only `changes` list).
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
  isDesignEvaluationEnabled,
  withQuestionnairesEnabled,
} from '@/lib/app/questionnaire/feature-flag';
import {
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
  type EvaluationDimension,
} from '@/lib/app/questionnaire/evaluation';
import { runEvaluationPanel } from '@/lib/app/questionnaire/evaluation/run-panel';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { designEvaluationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  listEvaluationRuns,
  persistEvaluationRun,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';

const bodySchema = z.object({
  /** Which dimensions to run; defaults to the whole panel. Deduped at use. */
  dimensions: z.array(z.enum(EVALUATION_DIMENSIONS)).max(EVALUATION_DIMENSIONS.length).optional(),
});

const handleCreateRun = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    // Sub-flag gate: the panel always spends seven LLM calls, so it's opt-in on top of the
    // master flag. Off → 404 (same as the preview route — no free deterministic half).
    if (!(await isDesignEvaluationEnabled())) {
      throw new NotFoundError('Questionnaire design-time evaluation is not enabled');
    }

    const body = await validateRequestBody(request, bodySchema);
    const dimensions: EvaluationDimension[] =
      body.dimensions && body.dimensions.length > 0
        ? [...new Set(body.dimensions)]
        : [...EVALUATION_DIMENSIONS];

    // Per-admin sub-cap on the paid panel — reuse the preview's limiter (same seven-call
    // cost), checked once per run before the DB work and the dispatch.
    const rl = designEvaluationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Design-evaluation rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const structure = await buildEvaluationStructure(id, vid);
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found');
    }

    // Load the judge agents for the requested dimensions in one query.
    const wantedSlugs = dimensions.map((d) => EVALUATION_DIMENSION_SPECS[d].slug);
    const agents = await prisma.aiAgent.findMany({
      where: { slug: { in: wantedSlugs }, kind: 'judge' },
      select: { slug: true, id: true, provider: true, model: true, fallbackProviders: true },
    });
    const agentBySlug = new Map(agents.map((a) => [a.slug, a]));

    // Every judge missing means the seed never ran — a config problem, not a per-run
    // failure. A subset missing is fail-soft per dimension inside the panel.
    if (agentBySlug.size === 0) {
      log.error('No design-evaluation judge agents found; run db:seed', { wantedSlugs });
      throw new NotFoundError('Questionnaire design-time evaluation is not configured');
    }

    const startedAt = new Date();
    const panel = await runEvaluationPanel({
      dimensions,
      structure,
      questionnaireId: id,
      versionId: vid,
      agentBySlug,
      adminId,
      log,
    });
    const completedAt = new Date();

    const run = await persistEvaluationRun({
      questionnaireId: id,
      versionId: vid,
      triggeredByUserId: adminId,
      panel,
      structure,
      startedAt,
      completedAt,
    });

    log.info('Questionnaire design-evaluation run persisted', {
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

    // Read-only: master-flag-gated (the wrapper) and version-scoped. No sub-flag 404 —
    // persisted history stays readable, the `changes` list posture.
    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const { searchParams } = new URL(request.url);
    const { page, limit, skip } = parsePaginationParams(searchParams);

    const { runs, total } = await listEvaluationRuns(vid, { skip, limit });
    log.info('Questionnaire design-evaluation runs listed', {
      versionId: vid,
      count: runs.length,
      total,
    });

    return paginatedResponse(runs, { page, limit, total });
  }
);

export const POST = withQuestionnairesEnabled(handleCreateRun);
export const GET = withQuestionnairesEnabled(handleListRuns);
