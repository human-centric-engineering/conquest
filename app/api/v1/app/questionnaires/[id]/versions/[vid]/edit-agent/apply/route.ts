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
 *   Guarded to **draft** versions with **no respondent sessions**.
 *
 * Auth: admin only. Flag: 404 when the master OR edit-agent sub-flag is off.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withEditAgentEnabled } from '@/lib/app/questionnaire/feature-flag';
import { resolveOps, EditOpError } from '@/lib/app/questionnaire/edit-agent/resolve';
import { composeLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  loadEditableStructure,
  applyResolvedChanges,
} from '@/app/api/v1/app/questionnaires/_lib/edit-agent-pipeline';
import {
  assertPersistable,
  IncoherentExtractionError,
  replaceVersionStructure,
} from '@/app/api/v1/app/questionnaires/_lib/persist';
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

    // Guard the target version (draft + no sessions) for both modes.
    const current = await loadEditableStructure(id, vid);
    if (!current.ok) return current.response;

    let counts: { changeCount: number; sectionCount: number; questionCount: number };
    let mode: 'precise' | 'rewrite';

    if (body.data.mode === 'precise') {
      mode = 'precise';
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
      const graph = await replaceVersionStructure(vid, body.data.structure);
      counts = {
        changeCount: graph.sectionCount + graph.questionCount,
        sectionCount: graph.sectionCount,
        questionCount: graph.questionCount,
      };
    }

    logAdminAction({
      userId: adminId,
      action: 'questionnaire.edit_agent',
      entityType: 'questionnaire',
      entityId: vid,
      entityName: mode,
      metadata: {
        questionnaireId: id,
        versionId: vid,
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
      versionId: vid,
      mode,
      ...counts,
    });

    return successResponse({ mode, ...counts });
  }
);

export const POST = withEditAgentEnabled(handleApply);
