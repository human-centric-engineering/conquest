/**
 * Re-run one failed judge into an existing evaluation run.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/evaluations/:runId/retry
 *   body: { dimension: EvaluationDimension }
 *
 * Admin-only. The panel is fail-soft per judge, so a run can complete with one judge missing —
 * which leaves the run's severity totals a silent undercount. Re-running the whole panel to fill
 * that hole costs six needless judge calls *and* discards the review decisions already recorded
 * against the run's findings. So this route dispatches the one judge and merges its outcome back
 * into the same run: the dimension's summary entry and findings are replaced, and the run's
 * tallies and terminal status are re-derived.
 *
 * The retry reads the run's **structure snapshot**, not the live structure — the run is a verdict
 * on the structure the other six judges saw, and mixing a judge's opinion of a newer draft into it
 * would make the run's per-finding staleness derivation meaningless. Only a pre-F5.3 run without a
 * snapshot falls back to the live structure.
 *
 * Retrying a judge that already returned a verdict is a 409: its findings may carry accept/apply
 * decisions, and silently deleting those to make room for a fresh opinion is not this route's call.
 * Re-run the panel for that.
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
  EVALUATION_DIMENSIONS,
  EVALUATION_DIMENSION_SPECS,
} from '@/lib/app/questionnaire/evaluation';
import { runEvaluationPanel } from '@/lib/app/questionnaire/evaluation/run-panel';
import { buildEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/evaluation-structure';
import { designEvaluationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  loadRunForJudgeRetry,
  mergeJudgeRetry,
} from '@/app/api/v1/app/questionnaires/_lib/evaluation-run-routes';

const bodySchema = z.object({
  /** The single failed judge to re-dispatch. */
  dimension: z.enum(EVALUATION_DIMENSIONS),
});

const handleRetryJudge = withAdminAuth<{ id: string; vid: string; runId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid, runId } = await params;
    const adminId = session.user.id;

    const { dimension } = await validateRequestBody(request, bodySchema);

    // One judge call, but it takes the same paid-panel sub-cap as a full run: a hammered retry
    // button is exactly the shape of spend that cap exists to bound.
    const rl = designEvaluationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Design-evaluation rate limit exceeded (judge retry)', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const run = await loadRunForJudgeRetry(vid, runId);
    if (!run || run.questionnaireId !== id) {
      throw new NotFoundError('Evaluation run not found');
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

    // The snapshot is what the run is a verdict on; only a pre-F5.3 run needs the live structure.
    const structure = run.snapshot ?? (await buildEvaluationStructure(id, vid));
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const slug = EVALUATION_DIMENSION_SPECS[dimension].slug;
    const agents = await prisma.aiAgent.findMany({
      where: { slug, kind: 'judge' },
      select: { slug: true, id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (agents.length === 0) {
      log.error('Judge agent missing on retry; run db:seed', { slug });
      throw new NotFoundError('That judge is not configured');
    }

    const panel = await runEvaluationPanel({
      dimensions: [dimension],
      structure,
      questionnaireId: id,
      versionId: vid,
      agentBySlug: new Map(agents.map((a) => [a.slug, a])),
      adminId,
      log,
    });

    // Exactly one dimension was requested, so the panel returns exactly one result. Guarded
    // anyway: a shape surprise here would otherwise write a half-merged run.
    const result = panel.results[0];
    if (!result) {
      throw new Error(`Judge retry for ${dimension} returned no result`);
    }

    const detail = await mergeJudgeRetry({ run, result, completedAt: new Date() });

    log.info('Questionnaire design-evaluation judge retried', {
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
