/**
 * Intro-background AI author endpoint (F12.2).
 *
 * POST /api/v1/app/questionnaires/intro-background/author
 *   Admin-only. Generates (from a brief) or refines (rewrite supplied text per an instruction) the
 *   respondent intro "about this questionnaire" markdown via one structured LLM call. Returns
 *   `{ background }`; it does NOT persist — the admin reviews and saves it via the config / cohort
 *   PATCH. Reuses the seeded composer agent (the shared authoring binding).
 *
 * Pipeline: intro flag-gate → withAdminAuth → per-admin sub-cap → JSON body → composer-agent load →
 *   capability dispatch → map errors → 200.
 */

import type { NextRequest } from 'next/server';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import { AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import type { AuthorIntroBackgroundData } from '@/lib/app/questionnaire/capabilities';
import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { loadComposerAgent } from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import { authorIntroBackgroundSchema } from '@/app/api/v1/app/questionnaires/intro-background/_lib/input';
import { loadIntroGenerationContext } from '@/app/api/v1/app/questionnaires/intro-background/_lib/generation-context';

/** Map a capability dispatch error code to an HTTP status (mirrors the compose pipeline). */
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
  if (status === 429) return 'AUTHORING_RATE_LIMITED';
  if (status === 400) return 'INVALID_AUTHORING_ARGS';
  if (status === 503) return 'AUTHORING_UNAVAILABLE';
  return 'AUTHORING_FAILED';
}

const handleAuthor = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const adminId = session.user.id;

  // Per-admin sub-cap — each author call is an LLM call. Shares the compose window (same spend class).
  const rl = composeLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Intro-background author rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  const body = authorIntroBackgroundSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return errorResponse('Invalid authoring request', {
      code: 'VALIDATION_ERROR',
      status: 400,
      details: { issues: body.error.issues },
    });
  }

  const agentResult = await loadComposerAgent(log);
  if (!agentResult.ok) return agentResult.response;
  const agent = agentResult.value;

  // Ground a generated intro in the questionnaire's goal + questions when the admin opted in (the
  // field sends the version pair). A mismatched/empty version yields null → generate from the brief
  // alone. The ids stay out of the capability args — it only ever sees the formatted context string.
  const { questionnaireId, versionId, ...authorArgs } = body.data;
  let questionnaireContext: string | undefined;
  if (body.data.mode === 'generate' && questionnaireId && versionId) {
    questionnaireContext =
      (await loadIntroGenerationContext(questionnaireId, versionId)) ?? undefined;
  }

  registerBuiltInCapabilities();

  const dispatch = await capabilityDispatcher.dispatch(
    AUTHOR_INTRO_BACKGROUND_CAPABILITY_SLUG,
    { ...authorArgs, ...(questionnaireContext ? { questionnaireContext } : {}) },
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
    log.warn('Intro-background authoring failed', {
      adminId,
      mode: body.data.mode,
      capabilityError: dispatch.error?.code,
      status,
    });
    return errorResponse(dispatch.error?.message ?? 'Authoring failed', {
      code: dispatchErrorCode(status),
      status,
      ...(dispatch.error?.code ? { details: { capabilityError: dispatch.error.code } } : {}),
    });
  }

  const data = dispatch.data as AuthorIntroBackgroundData;
  log.info('Intro-background authored', {
    adminId,
    mode: body.data.mode,
    chars: data.background.length,
    grounded: questionnaireContext !== undefined,
    clientIp,
  });
  return successResponse({ background: data.background });
});

export const POST = handleAuthor;
