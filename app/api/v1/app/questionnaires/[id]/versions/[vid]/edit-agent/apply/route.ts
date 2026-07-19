/**
 * Structure Edit Agent — apply endpoint (write).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/edit-agent/apply
 *   Admin-only. Persists a previewed plan. Two modes:
 *     - precise: re-loads the live structure, re-resolves the supplied ops against it (the preview
 *       is advisory — a concurrent edit can't be clobbered), and applies the resulting change list
 *       via granular per-entity updates in one transaction (weight/required the instruction did not
 *       name are preserved).
 *     - rewrite: validates the previewed structure and rewrites the whole graph via
 *       `replaceVersionStructure` (the same path the refine flow uses).
 *
 *   Launched or session-pinned versions are not blocked: like every authoring mutation this forks a
 *   fresh draft first (`forkVersionIfLaunched`) when the version is launched or has real respondent
 *   sessions, then applies to the fork — so in-flight work stays pinned to the version it started on.
 *   The precise ops re-resolve against the fork (key/ordinal-addressed, and the fork preserves both).
 *   The success `meta` carries the fork outcome so the editor can notice + redirect.
 *
 * Auth: admin only.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { resolveOps, EditOpError } from '@/lib/app/questionnaire/edit-agent/resolve';
import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  loadEditableStructure,
  applyResolvedChanges,
} from '@/app/api/v1/app/questionnaires/_lib/edit-agent-pipeline';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  assertPersistable,
  IncoherentExtractionError,
  replaceVersionStructure,
} from '@/app/api/v1/app/questionnaires/_lib/persist';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import { editApplyRequestSchema } from '@/app/api/v1/app/questionnaires/_lib/edit-agent-input';

const handleApply = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIP = getClientIP(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const rl = composeLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Edit-agent apply rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const body = editApplyRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return errorResponse('Invalid apply request', {
        code: 'VALIDATION_ERROR',
        status: 400,
        details: { issues: body.error.issues },
      });
    }

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    // Fork a new draft when the version is launched or pinned by real respondent sessions, then apply
    // to the fork; otherwise edit in place. Throws ForkConfirmationRequiredError (→ 409 via
    // handleAPIError) on an interactive `x-fork-confirm: prompt` request that hasn't confirmed yet.
    const fork = await forkVersionIfLaunched(scoped, { userId: adminId, clientIp: clientIP });
    const editId = fork.versionId;

    let counts: { changeCount: number; sectionCount: number; questionCount: number };
    let mode: 'precise' | 'rewrite';

    if (body.data.mode === 'precise') {
      mode = 'precise';
      // Re-resolve the previewed ops against the version we actually write (the fork when forked).
      const current = await loadEditableStructure(id, editId);
      if (!current.ok) return current.response;
      let changes;
      try {
        ({ changes } = resolveOps(current.value, body.data.operations));
      } catch (err) {
        if (err instanceof EditOpError) {
          return errorResponse(err.message, { code: 'EDIT_PLAN_INVALID', status: 422 });
        }
        throw err;
      }
      counts = await applyResolvedChanges(changes);
    } else {
      mode = 'rewrite';
      try {
        assertPersistable(body.data.structure);
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
      const graph = await replaceVersionStructure(editId, body.data.structure);
      counts = {
        changeCount: graph.sectionCount + graph.questionCount,
        sectionCount: graph.sectionCount,
        questionCount: graph.questionCount,
      };
    }

    // F14.15: record the edit. Precise mode writes no `AppQuestionnaireExtractionChange` rows at
    // all (the deterministic ops aren't extraction decisions), so before this the only durable
    // trace of an AI-authored structure change was an admin-audit row whose `entityName` was the
    // literal string "precise". The ops themselves — what actually changed — were unrecoverable.
    void recordAiRun({
      subjectKind: 'version',
      subjectId: editId,
      versionId: editId,
      kind: mode === 'precise' ? 'edit_precise' : 'edit_rewrite',
      // The applied plan, not the model call: the LLM that produced these ops ran in the preview
      // step, so provider/model are not resolvable here. Recorded as the apply seam it is.
      provider: 'n/a',
      model: 'n/a',
      outputSnapshot: body.data.mode === 'precise' ? body.data.operations : null,
      detail: {
        mode,
        forked: fork.forked,
        ...counts,
      },
      triggeredByUserId: adminId,
    });

    logAdminAction({
      userId: adminId,
      action: 'questionnaire.edit_agent',
      entityType: 'questionnaire',
      entityId: editId,
      entityName: mode,
      metadata: {
        questionnaireId: id,
        versionId: editId,
        forked: fork.forked,
        mode,
        changeCount: counts.changeCount,
        sectionCount: counts.sectionCount,
        questionCount: counts.questionCount,
      },
      clientIp: clientIP,
    });

    log.info('Edit-agent applied', {
      adminId,
      questionnaireId: id,
      versionId: editId,
      forked: fork.forked,
      mode,
      ...counts,
    });

    return successResponse({ mode, ...counts }, forkMeta(fork));
  }
);

export const POST = handleApply;
