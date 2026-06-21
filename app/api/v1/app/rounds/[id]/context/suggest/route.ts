/**
 * Round Additional Context — AI suggest endpoint (round Additional Context, phase 3).
 *
 * POST /api/v1/app/rounds/:id/context/suggest
 *   Admin-only. Evaluates a bundled version's questions (+ optional admin source material) and
 *   proposes interviewer "briefing" notes, each optionally attributed to a question. Returns
 *   `{ entries: [{ questionSlotId, title, content }] }`; it does NOT persist — the admin reviews,
 *   edits, and saves each via the normal create endpoint. Reuses the seeded composer agent.
 *
 * Pipeline: round-context flag-gate → withAdminAuth → per-admin sub-cap → JSON body → version
 *   membership check → questions load → composer-agent load → capability dispatch → map → 200.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import { withRoundContextEnabled } from '@/lib/app/questionnaire/feature-flag';
import { SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import type { SuggestRoundBriefingData } from '@/lib/app/questionnaire/capabilities';
import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { loadComposerAgent } from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import {
  assertRoundBundlesVersion,
  loadVersionForSuggest,
} from '@/app/api/v1/app/rounds/_lib/context';

type Params = { id: string };

const SOURCE_TEXT_MAX = 20_000;

const bodySchema = z.object({
  versionId: z.string().min(1, 'Version is required'),
  sourceText: z.string().max(SOURCE_TEXT_MAX).optional(),
  maxEntries: z.coerce.number().int().min(1).max(20).optional(),
});

/** Map a capability dispatch error code to an HTTP status (mirrors the intro-background author route). */
function dispatchErrorStatus(code: string | undefined): number {
  switch (code) {
    case 'rate_limited':
      return 429;
    case 'invalid_args':
      return 400;
    case 'no_provider_configured':
    case 'provider_unavailable':
    case 'capability_inactive':
    case 'capability_disabled_for_agent':
    case 'unknown_capability':
    case 'capability_quarantined':
    case 'requires_approval':
      return 503;
    default:
      return 502;
  }
}

function dispatchErrorCode(status: number): string {
  if (status === 429) return 'SUGGEST_RATE_LIMITED';
  if (status === 400) return 'INVALID_SUGGEST_ARGS';
  if (status === 503) return 'SUGGEST_UNAVAILABLE';
  return 'SUGGEST_FAILED';
}

const handleSuggest = withAdminAuth<Params>(async (request: NextRequest, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;
  const { id: roundId } = await params;

  // Per-admin sub-cap — each suggest call is an LLM call (shares the compose spend class/window).
  const rl = composeLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Suggest-briefing rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: roundId },
    select: { id: true },
  });
  if (!round) throw new NotFoundError('Round not found');

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse('Invalid suggest request', {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { issues: parsed.error.issues },
    });
  }
  const body = parsed.data;

  if (!(await assertRoundBundlesVersion(roundId, body.versionId))) {
    return errorResponse('That version is not part of this round', {
      code: 'VERSION_NOT_IN_ROUND',
      status: 400,
    });
  }

  const version = await loadVersionForSuggest(body.versionId);
  if (!version || version.questions.length === 0) {
    return errorResponse('That version has no questions to brief against yet', {
      code: 'NO_QUESTIONS',
      status: 400,
    });
  }

  const agentResult = await loadComposerAgent(log);
  if (!agentResult.ok) return agentResult.response;
  const agent = agentResult.value;

  registerBuiltInCapabilities();

  const dispatch = await capabilityDispatcher.dispatch(
    SUGGEST_ROUND_BRIEFING_CAPABILITY_SLUG,
    {
      ...(version.goal ? { goal: version.goal } : {}),
      questions: version.questions,
      ...(body.sourceText ? { sourceText: body.sourceText } : {}),
      ...(body.maxEntries ? { maxEntries: body.maxEntries } : {}),
    },
    {
      userId: adminId,
      agentId: agent.id,
      entityContext: {
        composerAgent: {
          provider: agent.provider,
          model: agent.model,
          fallbackProviders: agent.fallbackProviders,
        },
      },
    }
  );

  if (!dispatch.success || !dispatch.data) {
    const status = dispatchErrorStatus(dispatch.error?.code);
    log.warn('Suggest-briefing failed', {
      adminId,
      roundId,
      capabilityError: dispatch.error?.code,
      status,
    });
    return errorResponse(dispatch.error?.message ?? 'Suggestion failed', {
      code: dispatchErrorCode(status),
      status,
      ...(dispatch.error?.code ? { details: { capabilityError: dispatch.error.code } } : {}),
    });
  }

  const data = dispatch.data as SuggestRoundBriefingData;
  // The UI speaks `questionSlotId`; the capability returns `questionId`. Rename at the boundary.
  const entries = data.entries.map((e) => ({
    questionSlotId: e.questionId,
    title: e.title,
    content: e.content,
  }));
  log.info('Suggest-briefing produced proposals', {
    adminId,
    roundId,
    versionId: body.versionId,
    count: entries.length,
    clientIp,
  });
  return successResponse({ entries });
});

export const POST = withRoundContextEnabled(handleSuggest);
