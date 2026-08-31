/**
 * Respondent Report — streamed configured-report preview (admin).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/report/preview/stream
 *   Admin-only. Identical guards and work to the synchronous preview route, but streams the run over
 *   SSE: an opening `started` (carrying what the sample respondent has to cover), then a phase event
 *   per boundary — `persona`, `sampling` (with a batches-done counter), `writing`, `formatting`,
 *   `finishing` — and finally `done` (carrying the rendered sample report) or `error`.
 *
 *   Why: a measured 69-question version takes ~100 seconds. The editor's dialog previously showed one
 *   static spinner for the whole run, so a slow preview and a hung one looked identical and there was
 *   no honest signal that waiting was worth it. Paid LLM work → the same per-admin preview sub-cap.
 *
 * Pre-stream guards return ordinary JSON errors (400 / 404 / 429); once those pass the response
 * switches to `text/event-stream` and all further outcomes are SSE events.
 */

import { z } from 'zod';

import { errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { sseResponse } from '@/lib/api/sse';

import {
  checkPreviewStructure,
  loadPreviewStructure,
  preparePreviewSettings,
  streamReportPreview,
} from '@/lib/app/questionnaire/report/preview-run';
import { reportPreviewLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/** The editor sends the whole `respondentReport` block as `config` (defensively narrowed here). */
const previewRequestSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

/** Same wall-clock ceiling as the synchronous route — see its note. */
export const maxDuration = 300;

const handlePreviewStream = withAdminAuth<{ id: string; vid: string }>(
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

    log.info('Report preview streamed generation started', {
      adminId,
      questionnaireId: id,
      versionId: vid,
      mode: prepared.settings.mode,
    });
    return sseResponse(
      streamReportPreview({
        structure,
        settings: prepared.settings,
        versionId: vid,
        questionnaireId: id,
        adminId,
      }),
      { signal: request.signal }
    );
  }
);

export const POST = handlePreviewStream;
