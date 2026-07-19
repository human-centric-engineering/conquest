/**
 * Structure Edit Agent — plan endpoint (preview, no write).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/edit-agent/plan
 *   Admin-only. Turns a plain-English instruction for the whole questionnaire into a previewable set
 *   of changes — WITHOUT persisting anything. Two modes:
 *     - precise (default): the edit agent translates the instruction into deterministic edit-ops,
 *       which are resolved against the current structure into a concrete before→after change list.
 *     - rewrite: the refine capability rewrites the whole structure (LLM); we return the proposed
 *       structure + an outline for the preview, still without writing.
 *   Preview is read-only, so it never blocks on version status or sessions; the apply route owns the
 *   fork-a-new-draft decision for launched / session-pinned versions.
 *
 * Auth: admin only. Rate limit: per-admin compose sub-cap (shared with the compose/refine routes —
 * same class of paid reasoning work).
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import { REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG } from '@/lib/app/questionnaire/constants';
import type { RefineQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import { planEditOps } from '@/lib/app/questionnaire/edit-agent/translate';
import { resolveOps, EditOpError } from '@/lib/app/questionnaire/edit-agent/resolve';
import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { loadEditableStructure } from '@/app/api/v1/app/questionnaires/_lib/edit-agent-pipeline';
import {
  loadComposerAgent,
  loadRefinableStructure,
} from '@/app/api/v1/app/questionnaires/_lib/compose-pipeline';
import {
  assertPersistable,
  IncoherentExtractionError,
} from '@/app/api/v1/app/questionnaires/_lib/persist';
import { editPlanRequestSchema } from '@/app/api/v1/app/questionnaires/_lib/edit-agent-input';

/** Map a precise-translation failure code to an HTTP status. */
function planErrorStatus(code: string): number {
  switch (code) {
    case 'edit_agent_not_configured':
    case 'no_provider_configured':
    case 'provider_unavailable':
      return 503;
    default:
      return 502;
  }
}

/** Map a refine dispatch error code to an HTTP status (mirrors the refine route). */
function dispatchStatus(code: string | undefined): number {
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

const handlePlan = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const rl = composeLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Edit-agent plan rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const body = editPlanRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse('Invalid plan request', {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { issues: body.error.issues },
      });
    }
    const { instruction, mode } = body.data;

    // ---- precise mode: instruction → deterministic edit-ops → change list ----
    if (mode === 'precise') {
      const current = await loadEditableStructure(id, vid);
      if (!current.ok) return current.response;

      const plan = await planEditOps(instruction, current.value);
      if (!plan.ok) {
        const status = planErrorStatus(plan.code);
        log.warn('Edit-agent plan failed', { adminId, versionId: vid, code: plan.code, status });
        return errorResponse(plan.message, {
          code: 'EDIT_PLAN_FAILED',
          status,
          details: { reason: plan.code },
        });
      }

      try {
        const { changes } = resolveOps(current.value, plan.value.operations);
        return successResponse({
          mode: 'precise',
          summary: plan.value.summary,
          operations: plan.value.operations,
          changes,
        });
      } catch (err) {
        if (err instanceof EditOpError) {
          log.warn('Edit-agent plan produced an impossible op', { adminId, versionId: vid });
          return errorResponse(err.message, { code: 'EDIT_PLAN_INVALID', status: 422 });
        }
        throw err;
      }
    }

    // ---- rewrite mode: whole-doc LLM regenerate (no persist) ----
    const current = await loadRefinableStructure(id, vid);
    if (!current.ok) return current.response;

    const agentResult = await loadComposerAgent(log);
    if (!agentResult.ok) return agentResult.response;
    const agent = agentResult.value;

    registerBuiltInCapabilities();
    const dispatch = await capabilityDispatcher.dispatch(
      REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
      { currentStructure: current.value, instruction },
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
      const status = dispatchStatus(dispatch.error?.code);
      log.warn('Edit-agent rewrite plan failed', { adminId, versionId: vid, status });
      return errorResponse(dispatch.error?.message ?? 'Rewrite failed', {
        code: 'EDIT_REWRITE_FAILED',
        status,
      });
    }

    const refined = dispatch.data as RefineQuestionnaireStructureData;
    try {
      assertPersistable(refined.structure);
    } catch (err) {
      if (err instanceof IncoherentExtractionError) {
        return errorResponse(err.message, {
          code: 'EDIT_REWRITE_INCOHERENT',
          status: 422,
          details: { orphanSectionOrdinals: err.orphanSectionOrdinals },
        });
      }
      throw err;
    }

    // A coarse outline for the preview — section titles with their question counts.
    const outline = [...refined.structure.sections]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((s) => ({
        title: s.title,
        questionCount: refined.structure.questions.filter((q) => q.sectionOrdinal === s.ordinal)
          .length,
      }));

    return successResponse({
      mode: 'rewrite',
      summary: refined.summary,
      structure: refined.structure,
      outline,
    });
  }
);

export const POST = handlePlan;
