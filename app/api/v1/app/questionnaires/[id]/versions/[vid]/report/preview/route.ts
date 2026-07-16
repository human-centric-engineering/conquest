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
 *   Gate order: master flag (404 before auth) → withAdminAuth → per-admin preview sub-cap (two LLM
 *   calls per preview) → validate → load version structure → synthesise → generate. Only the AI modes
 *   (`raw_plus_insights`, `narrative`) generate a report; a `raw` config is rejected (its output is just
 *   the respondent's answers, previewed via the respondent walkthrough).
 */

import { z } from 'zod';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

import { isAiRespondentReportMode } from '@/lib/app/questionnaire/types';
import { parseAudienceShape } from '@/lib/app/questionnaire/evaluation/structure-schema';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import { generateReportFromInputs } from '@/lib/app/questionnaire/report/generate';
import {
  synthesiseSampleReportInputs,
  type PreviewStructure,
} from '@/lib/app/questionnaire/report/preview-sample';
import { reportPreviewLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/** The editor sends the whole `respondentReport` block as `config` (defensively narrowed here). */
const previewRequestSchema = z.object({
  config: z.record(z.string(), z.unknown()),
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
    const settings = narrowRespondentReportSettings(body.config);

    if (!isAiRespondentReportMode(settings.mode)) {
      return errorResponse('Preview is only available for the AI report modes.', {
        code: 'REPORT_PREVIEW_MODE_UNSUPPORTED',
        status: 400,
      });
    }

    // Load the version structure (scoped to the questionnaire) — questions + data slots the sample
    // answerer needs, plus the header context.
    const version = await prisma.appQuestionnaireVersion.findFirst({
      where: { id: vid, questionnaireId: id },
      select: {
        goal: true,
        audience: true,
        questionnaire: { select: { title: true } },
        sections: {
          orderBy: { ordinal: 'asc' },
          select: {
            id: true,
            title: true,
            questions: {
              orderBy: { ordinal: 'asc' },
              select: { key: true, prompt: true, required: true },
            },
          },
        },
        dataSlots: {
          orderBy: { ordinal: 'asc' },
          select: { key: true, name: true, description: true, theme: true },
        },
      },
    });
    if (!version) throw new NotFoundError('Questionnaire version not found');

    const structure: PreviewStructure = {
      questionnaireTitle: version.questionnaire.title,
      goal: version.goal,
      audience: parseAudienceShape(version.audience),
      sections: version.sections.map((s) => ({
        sectionId: s.id,
        title: s.title,
        questions: s.questions.map((q) => ({
          key: q.key,
          prompt: q.prompt,
          required: q.required,
        })),
      })),
      dataSlots: version.dataSlots.map((ds) => ({
        key: ds.key,
        name: ds.name,
        description: ds.description,
        theme: ds.theme,
      })),
    };

    // Nothing to sample from → tell the admin to add questions rather than burning two LLM calls on a
    // structurally-impossible preview and returning a transient-sounding 502.
    const hasQuestions = structure.sections.some((s) => s.questions.length > 0);
    if (!hasQuestions && structure.dataSlots.length === 0) {
      return errorResponse('Add questions to this version before previewing the report.', {
        code: 'REPORT_PREVIEW_EMPTY_VERSION',
        status: 400,
      });
    }

    // Preview must be fast/cheap/deterministic: no external web search, no KB dependency.
    const previewSettings = {
      ...settings,
      generation: { ...settings.generation, useClientKnowledge: false },
      research: { ...settings.research, enabled: false },
    };

    try {
      const sample = await synthesiseSampleReportInputs(structure, {
        includeConfidence: previewSettings.generation.discountLowConfidence,
      });
      const report = await generateReportFromInputs({
        settings: previewSettings,
        goal: structure.goal,
        transcript: sample.transcript,
        dataSlotContext: sample.dataSlotContext,
        // Sample answers cover the questionnaire — no partial-completion caveat in a preview.
        completionPct: 100,
        demoClientId: null,
        sessionId: `preview:${vid}`,
      });
      log.info('Report preview generated', {
        adminId,
        questionnaireId: id,
        versionId: vid,
        mode: previewSettings.mode,
      });
      return successResponse({
        questionnaireTitle: structure.questionnaireTitle,
        mode: previewSettings.mode,
        content: report.content,
        formatted: report.formatted,
        completionPct: report.completionPct,
      });
    } catch (err) {
      logger.error('Report preview failed', {
        adminId,
        questionnaireId: id,
        versionId: vid,
        error: errorMessage(err),
      });
      return errorResponse('Could not generate a preview. Please try again.', {
        code: 'REPORT_PREVIEW_FAILED',
        status: 502,
      });
    }
  }
);

export const POST = handlePreview;
