/**
 * Respondent Report — configured-report preview (admin).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/report/preview
 *   Admin-only. Renders how the CURRENT (possibly unsaved) report config would look, before going
 *   live: it synthesises a plausible sample respondent for the version's structure, then runs the real
 *   generation core to produce an illustrative report. Web search + knowledge-base grounding are forced
 *   OFF for the preview (fast, cheap, deterministic) — the returned report is a sample, never a real
 *   respondent's. Persists nothing.
 *
 *   Gate order: withAdminAuth → per-admin preview sub-cap (several LLM calls per preview) → validate →
 *   load version structure → synthesise → generate. Only the AI modes
 *   (`raw_plus_insights`, `narrative`) generate a report; a `raw` config is rejected (its output is just
 *   the respondent's answers, previewed via the respondent walkthrough).
 *
 *   This is the one-response form, kept for headless callers. The admin editor uses the streamed
 *   sibling (`./stream`), which reports each phase as it happens — a preview takes ~100 seconds, and
 *   a silent spinner for that long is indistinguishable from a hang. Both share
 *   `lib/app/questionnaire/report/preview-run.ts`, so they cannot diverge.
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logger } from '@/lib/logging';

import {
  classifyPreviewFailure,
  checkPreviewStructure,
  errorMessage,
  loadPreviewStructure,
  preparePreviewSettings,
  runReportPreview,
  type PreviewStage,
} from '@/lib/app/questionnaire/report/preview-run';
import { reportPreviewLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/** The editor sends the whole `respondentReport` block as `config` (defensively narrowed here). */
const previewRequestSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

/**
 * Wall-clock ceiling for the whole preview. It runs a persona pass, a fan-out of sample-answer
 * batches, the report writer, and the formatter back to back — a large version measures at ~2
 * minutes end to end, well past the platform's 60s default. Without this the function is killed
 * mid-flight and the admin gets a blank failure with nothing in the logs to explain it.
 */
export const maxDuration = 300;

const handlePreview = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const adminId = session.user.id;
    const { id, vid } = await params;

    const rl = reportPreviewLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Report preview rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const body = await validateRequestBody(request, previewRequestSchema);
    const prepared = preparePreviewSettings(body.config);
    if (!prepared.ok) {
      return errorResponse(prepared.refusal.message, {
        code: prepared.refusal.code,
        status: prepared.refusal.status,
      });
    }

    const structure = await loadPreviewStructure(id, vid);
    if (!structure) throw new NotFoundError('Questionnaire version not found');

    const structureRefusal = checkPreviewStructure(structure);
    if (structureRefusal) {
      return errorResponse(structureRefusal.message, {
        code: structureRefusal.code,
        status: structureRefusal.status,
      });
    }

    // Which pass we're in, so a failure below names it. The previous handler logged only the raw
    // message ("Request timed out.") with no indication of which of the LLM passes produced it,
    // which made a production timeout undiagnosable from the logs alone.
    let stage: PreviewStage = 'sample';
    try {
      const payload = await runReportPreview({
        structure,
        settings: prepared.settings,
        versionId: vid,
        onStage: (s) => {
          stage = s;
        },
      });
      log.info('Report preview generated', {
        adminId,
        questionnaireId: id,
        versionId: vid,
        mode: prepared.settings.mode,
      });
      return successResponse(payload);
    } catch (err) {
      const refusal = classifyPreviewFailure(err);
      logger.error('Report preview failed', {
        adminId,
        questionnaireId: id,
        versionId: vid,
        stage,
        timedOut: refusal.code === 'REPORT_PREVIEW_TIMEOUT',
        error: errorMessage(err),
      });
      return errorResponse(refusal.message, { code: refusal.code, status: refusal.status });
    }
  }
);

export const POST = handlePreview;
