/**
 * Conditional Topics evaluation preview (F17.21).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/topics/evaluate-preview
 *   body: { dimensions?: ScopeEvaluationDimension[] }   // default: all four
 *
 *   Admin-only. Runs the scope-evaluation judge panel over a version's authored Conditional Topics
 *   configuration — one structured LLM call per dimension — and returns each judge's verdict (a
 *   score in [0, 1] plus actionable findings). A read-only *preview*, mirroring F5.1's
 *   `evaluate-preview`: it persists nothing, because the run + finding tables are a later phase of
 *   F17.21 and the review queue with them. Its purpose is to let admins tune the panel and
 *   sanity-check a scope config before launch, and to give the persisted-run phase a proven
 *   dispatch seam to build on.
 *
 *   404 when the version is absent. The whole route is paid LLM work — there is no free
 *   deterministic result to fall back to — so the run takes a per-admin LLM sub-cap. Per-judge
 *   failure is fail-soft — a dimension that errors returns a `diagnostic` instead of a verdict, and
 *   the other three still return — so one flaky judge never 5xxs the whole panel.
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
  SCOPE_EVALUATION_DIMENSIONS,
  SCOPE_EVALUATION_DIMENSION_SPECS,
  type ScopeEvaluationDimension,
} from '@/lib/app/questionnaire/scope-evaluation';
// Imported from its own leaf, not the barrel above — see that barrel's comment on why
// `run-panel.ts` (it imports the capability dispatcher → Prisma) is never re-exported there.
import { runScopeEvaluationPanel } from '@/lib/app/questionnaire/scope-evaluation/run-panel';
import { buildScopeEvaluationStructure } from '@/app/api/v1/app/questionnaires/_lib/scope-evaluation-structure';
import { scopeEvaluationLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/**
 * Wall-clock ceiling for the whole panel — same reasoning and same number as the design-evaluation
 * preview route: four judges fan out concurrently, so the run costs one slow judge at worst (a
 * reasoning model, retried once at a fresh 90s timeout each), i.e. 180s — past the platform's 60s
 * default. No reconcile step here (see `run-panel.ts`'s module doc), so the fan-out is all it pays
 * for and this ceiling has more headroom than the seven-judge panel's.
 */
export const maxDuration = 300;

const bodySchema = z.object({
  /** Which dimensions to run; defaults to the whole panel. Deduped at use. */
  dimensions: z
    .array(z.enum(SCOPE_EVALUATION_DIMENSIONS))
    .max(SCOPE_EVALUATION_DIMENSIONS.length)
    .optional(),
});

const handleEvaluateScopePreview = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const body = await validateRequestBody(request, bodySchema);
    const dimensions: ScopeEvaluationDimension[] =
      body.dimensions && body.dimensions.length > 0
        ? [...new Set(body.dimensions)]
        : [...SCOPE_EVALUATION_DIMENSIONS];

    // Per-admin sub-cap on the paid panel (the section 100/min is far too loose for a four-call
    // fan-out). Checked before the DB work and the dispatch.
    const rl = scopeEvaluationLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Scope-evaluation rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const structure = await buildScopeEvaluationStructure(id, vid);
    if (!structure) {
      throw new NotFoundError('Questionnaire version not found');
    }

    // Load the judge agents for the requested dimensions in one query — each carries the
    // provider-agnostic binding the capability resolves from the dispatch context.
    const wantedSlugs = dimensions.map((d) => SCOPE_EVALUATION_DIMENSION_SPECS[d].slug);
    const agents = await prisma.aiAgent.findMany({
      where: { slug: { in: wantedSlugs }, kind: 'judge' },
      select: { slug: true, id: true, provider: true, model: true, fallbackProviders: true },
    });
    const agentBySlug = new Map(agents.map((a) => [a.slug, a]));

    // Every judge missing means the seed never ran — a config problem, not a per-run failure. A
    // subset missing is fail-soft per dimension below.
    if (wantedSlugs.every((slug) => !agentBySlug.has(slug))) {
      log.error('No scope-evaluation judge agents found; run db:seed', { wantedSlugs });
      throw new NotFoundError('Conditional Topics evaluation is not configured');
    }

    const { results, summary } = await runScopeEvaluationPanel({
      dimensions,
      structure,
      questionnaireId: id,
      versionId: vid,
      agentBySlug,
      adminId,
      log,
    });

    log.info('Conditional Topics evaluation preview', {
      questionnaireId: id,
      versionId: vid,
      ...summary,
    });

    return successResponse({ results, summary });
  }
);

export const POST = handleEvaluateScopePreview;
