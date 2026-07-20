/**
 * Experience-wide synthesis — generation (P15.8).
 *
 * POST /api/v1/app/experiences/:id/synthesis/generate
 *   Admin-only. Assembles the finished per-step outputs, runs the seeded experience synthesiser
 *   over them, stores the result, and returns the refreshed view.
 *
 * Synchronous rather than queued. Every input is already-generated prose, so this is one LLM call
 * over loaded text — there is no cohort worker to hook into, and standing one up would add a lease,
 * a claim loop and an orphan-recovery path to buy nothing an admin waiting on a button press would
 * notice. Paid work, so it carries the same per-admin generate sub-cap as the step reports.
 *
 * No separate enable gate: every input has ALREADY passed its own opt-in (a step report only exists
 * because reporting was enabled for that version; an insight only exists because a meeting ran and
 * cleared the support floor). Adding a second switch here would let an admin turn off a view of
 * data they have already consented to producing, which protects nobody.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cohortReportGenerateLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

import { buildSynthesisMaterial } from '@/lib/app/questionnaire/experiences/synthesis/material';
import { generateExperienceSynthesis } from '@/lib/app/questionnaire/experiences/synthesis/generate';
import {
  beginExperienceSynthesis,
  completeExperienceSynthesis,
  failExperienceSynthesis,
  getExperienceSynthesisView,
} from '@/lib/app/questionnaire/experiences/synthesis/persist';

type Params = { id: string };

const handleGenerate = withAdminAuth<Params>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;
  const { id } = await params;

  const experience = await prisma.appExperience.findUnique({
    where: { id },
    select: { id: true, title: true },
  });
  if (!experience) throw new NotFoundError('Experience not found');

  // Shared with the step-report generate cap deliberately: the cap bounds an admin's LLM spend, and
  // which report they asked for does not change that.
  const rl = cohortReportGenerateLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Experience synthesis generate rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const material = await buildSynthesisMaterial(id);

  // Nothing ready is an ordinary state, not a failure: the admin has not generated the step reports
  // yet. Answering 409 with the coverage attached lets the panel say exactly which steps are
  // missing rather than "something went wrong".
  if (material.blocks.length === 0) {
    return errorResponse('No step has a finished report to synthesise yet', {
      code: 'NOTHING_TO_SYNTHESISE',
      status: 409,
      details: { coverage: material.coverage },
    });
  }

  await beginExperienceSynthesis(id, adminId);

  try {
    const { content, costUsd } = await generateExperienceSynthesis(material);
    await completeExperienceSynthesis({
      experienceId: id,
      content,
      coveredSteps: material.blocks.length,
      eligibleSteps: material.coverage.length,
      costUsd,
    });

    logAdminAction({
      userId: adminId,
      action: 'app_experience_synthesis.generate',
      entityType: 'app_experience_synthesis',
      entityId: id,
      entityName: experience.title,
      metadata: {
        experienceKind: material.experienceKind,
        coveredSteps: material.blocks.length,
        eligibleSteps: material.coverage.length,
        costUsd,
      },
      clientIp,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('experience synthesis: generation failed', { experienceId: id, error: message });
    await failExperienceSynthesis(id, message);
    return errorResponse('Synthesis generation failed', {
      code: 'GENERATION_FAILED',
      status: 502,
    });
  }

  const view = await getExperienceSynthesisView(id);
  return successResponse(view);
});

export { handleGenerate as POST };
