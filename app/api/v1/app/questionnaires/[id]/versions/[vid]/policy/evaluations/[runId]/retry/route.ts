/**
 * Re-run one failed policy judge into an existing evaluation run (F18.8).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/policy/evaluations/:runId/retry
 *   body: { dimension: PolicyEvaluationDimension }
 *
 * Admin-only. Mirrors the design-evaluation retry route: the panel is fail-soft per judge, so a
 * run can complete with one judge missing, undercounting its totals. This dispatches the one
 * judge and merges its outcome back into the same run rather than re-running the whole panel.
 *
 * The retry reads the run's structure SNAPSHOT, not the live config — the run is a verdict on the
 * config the other judges saw. Only a run without a snapshot falls back to the live config.
 *
 * Retrying a judge that already returned a verdict is a 409 — its findings may carry review
 * decisions; re-run the panel for a fresh opinion instead.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { ConflictError, NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';

import { prisma } from '@/lib/db/client';
import {
  POLICY_EVALUATION_DIMENSIONS,
  POLICY_EVALUATION_DIMENSION_SPECS,
} from '@/lib/app/questionnaire/policy-evaluation';
// Imported from its own leaf, not the barrel above — see that barrel's comment on why
// `run-panel.ts` (it imports the capability dispatcher → Prisma) is never re-exported there.
import { runPolicyEvaluationPanel } from '@/lib/app/questionnaire/policy-evaluation/run-panel';
import { buildPolicyEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-structure';
import { policyEvaluationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  loadRunForPolicyJudgeRetry,
  mergePolicyJudgeRetry,
} from '@/app/api/v1/app/questionnaires/_lib/policy-evaluation-run-routes';

const bodySchema = z.object({
  dimension: z.enum(POLICY_EVALUATION_DIMENSIONS),
});

const handleRetryJudge = withAdminAuth<{ id: string; vid: string; runId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid, runId } = await params;
    const adminId = session.user.id;

    const { dimension } = await validateRequestBody(request, bodySchema);

    const rl = policyEvaluationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Policy-evaluation rate limit exceeded (judge retry)', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const run = await loadRunForPolicyJudgeRetry(vid, runId);
    if (!run || run.questionnaireId !== id) {
      throw new NotFoundError('Policy evaluation run not found');
    }

    const entry = run.summary.find((d) => d.dimension === dimension);
    if (!entry) {
      throw new NotFoundError('That judge was not part of this run');
    }
    if (entry.diagnostic === null) {
      throw new ConflictError('That judge already returned a verdict', {
        reason: 'judge_did_not_fail',
      });
    }

    const structure = run.snapshot ?? (await buildPolicyEvaluationStructure(id, vid));
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const slug = POLICY_EVALUATION_DIMENSION_SPECS[dimension].slug;
    const agents = await prisma.aiAgent.findMany({
      where: { slug, kind: 'judge' },
      select: { slug: true, id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (agents.length === 0) {
      log.error('Policy judge agent missing on retry; run db:seed', { slug });
      throw new NotFoundError('That judge is not configured');
    }

    const panel = await runPolicyEvaluationPanel({
      dimensions: [dimension],
      structure,
      questionnaireId: id,
      versionId: vid,
      agentBySlug: new Map(agents.map((a) => [a.slug, a])),
      adminId,
      log,
    });

    const result = panel.results[0];
    if (!result) {
      throw new Error(`Policy judge retry for ${dimension} returned no result`);
    }

    const detail = await mergePolicyJudgeRetry({ run, result, completedAt: new Date() });

    log.info('Interviewer-policy evaluation judge retried', {
      questionnaireId: id,
      versionId: vid,
      runId,
      dimension,
      succeeded: result.verdict !== undefined,
      diagnostic: result.diagnostic ?? null,
      status: detail.status,
    });

    return successResponse(detail);
  }
);

export const POST = handleRetryJudge;
