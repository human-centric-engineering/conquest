/**
 * Respondent Report preview — the shared run, and the streamed form of it.
 *
 * Two routes drive the same work: the synchronous `…/report/preview` (one JSON response, for
 * headless callers) and the streamed `…/report/preview/stream` (SSE, what the admin editor uses).
 * Everything except the transport lives here so the two can't diverge: loading the version's
 * structure, the two "there is nothing to preview" guards, forcing web search + KB grounding off,
 * running the sample synthesiser and the generation core, and classifying a failure.
 *
 * Why the stream exists: a measured 69-question version takes ~100 seconds end to end (~35s to
 * synthesise a sample respondent, ~60s to write and lay out the report). The dialog used to show one
 * static spinner for all of it, which is indistinguishable from a hung request — the admin has no
 * way to tell "this takes two minutes" from "this is broken", and no reason to keep waiting. The
 * streamed form reports each phase as it starts, so the wait is legible and the connection is
 * visibly alive.
 *
 * Server-side only (touches Prisma and the providers).
 *
 * @see lib/app/questionnaire/report/progress-events.ts — the phase vocabulary and event union
 * @see .context/app/questionnaire/respondent-report.md — "Config preview (AI-synthesised)"
 */

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
import { createProgressChannel } from '@/lib/app/questionnaire/llm/progress-channel';
import type {
  ReportPreviewEvent,
  ReportProgressEmitter,
} from '@/lib/app/questionnaire/report/progress-events';
import type { RespondentReportSettings } from '@/lib/app/questionnaire/types';

/** The preview payload both routes return (as JSON, or as the stream's terminal `done`). */
export interface ReportPreviewPayload {
  questionnaireTitle: string;
  mode: string;
  content: unknown;
  formatted: boolean;
  completionPct: number;
}

/** A refusal both routes render the same way — as a JSON error, or as the stream's `error`. */
export interface ReportPreviewRefusal {
  code: string;
  message: string;
  status: number;
}

/** The preview stage an error came from — recorded so a failure names the pass that produced it. */
export type PreviewStage = 'sample' | 'generate';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Did this fail because something ran out of time, rather than breaking?
 *
 * Worth separating because the two need opposite advice: a timeout is transient and worth retrying,
 * anything else is not. The shapes come from three layers that don't share an error type — the
 * OpenAI SDK (`APIConnectionTimeoutError`, message "Request timed out."), `AbortSignal.timeout`
 * (a `TimeoutError` DOMException), and the platform's own `ProviderError` (`code: 'timeout'`).
 */
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'APIConnectionTimeoutError') return true;
  if ('code' in err && err.code === 'timeout') return true;
  return /timed out/i.test(err.message);
}

/**
 * Turn a thrown generation error into the refusal an admin sees. A timeout is transient and retrying
 * is genuinely the right advice; anything else is not, and telling an admin to "try again" on a
 * broken config just makes them do it twice.
 */
export function classifyPreviewFailure(err: unknown): ReportPreviewRefusal {
  if (isTimeoutError(err)) {
    return {
      code: 'REPORT_PREVIEW_TIMEOUT',
      message:
        'The preview took too long to generate. Larger questionnaires take longer — please try again.',
      status: 504,
    };
  }
  return {
    code: 'REPORT_PREVIEW_FAILED',
    message: 'Could not generate a preview. Please try again.',
    status: 502,
  };
}

/**
 * Narrow the editor's posted `respondentReport` block, and refuse the one mode that has nothing to
 * preview: a `raw` config's output is just the respondent's answers, previewed via the respondent
 * walkthrough rather than here.
 */
export function preparePreviewSettings(
  config: Record<string, unknown>
): { ok: true; settings: RespondentReportSettings } | { ok: false; refusal: ReportPreviewRefusal } {
  const settings = narrowRespondentReportSettings(config);
  if (!isAiRespondentReportMode(settings.mode)) {
    return {
      ok: false,
      refusal: {
        code: 'REPORT_PREVIEW_MODE_UNSUPPORTED',
        message: 'Preview is only available for the AI report modes.',
        status: 400,
      },
    };
  }
  // Preview must be fast/cheap/deterministic: no external web search, no KB dependency.
  return {
    ok: true,
    settings: {
      ...settings,
      generation: { ...settings.generation, useClientKnowledge: false },
      research: { ...settings.research, enabled: false },
    },
  };
}

/**
 * Load the version's questions + data slots (scoped to the questionnaire), or `null` when the
 * version doesn't exist under it.
 */
export async function loadPreviewStructure(
  questionnaireId: string,
  versionId: string
): Promise<PreviewStructure | null> {
  const version = await prisma.appQuestionnaireVersion.findFirst({
    where: { id: versionId, questionnaireId },
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
  if (!version) return null;

  return {
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
}

/**
 * Nothing to sample from → tell the admin to add questions rather than burning LLM calls on a
 * structurally-impossible preview and returning a transient-sounding 502.
 */
export function checkPreviewStructure(structure: PreviewStructure): ReportPreviewRefusal | null {
  const hasQuestions = structure.sections.some((s) => s.questions.length > 0);
  if (!hasQuestions && structure.dataSlots.length === 0) {
    return {
      code: 'REPORT_PREVIEW_EMPTY_VERSION',
      message: 'Add questions to this version before previewing the report.',
      status: 400,
    };
  }
  return null;
}

/** How many questions / data slots the sample respondent has to cover (for the opening phase event). */
export function previewStructureCounts(structure: PreviewStructure): {
  questionCount: number;
  dataSlotCount: number;
} {
  return {
    questionCount: structure.sections.reduce((n, s) => n + s.questions.length, 0),
    dataSlotCount: structure.dataSlots.length,
  };
}

export interface RunReportPreviewParams {
  structure: PreviewStructure;
  /** Already through {@link preparePreviewSettings} (AI mode, KB + research forced off). */
  settings: RespondentReportSettings;
  versionId: string;
  /** Optional phase emitter — the streamed route passes one, the synchronous route does not. */
  onProgress?: ReportProgressEmitter;
  /** Set to the pass that threw, so a caller can log which of the two produced the failure. */
  onStage?: (stage: PreviewStage) => void;
}

/**
 * Synthesise a sample respondent and generate the report they would receive. Throws on an
 * unrecoverable failure — callers run it through {@link classifyPreviewFailure}.
 */
export async function runReportPreview(
  params: RunReportPreviewParams
): Promise<ReportPreviewPayload> {
  const { structure, settings, versionId, onProgress, onStage } = params;

  onStage?.('sample');
  const sample = await synthesiseSampleReportInputs(structure, {
    includeConfidence: settings.generation.discountLowConfidence,
    ...(onProgress ? { onProgress } : {}),
  });

  onStage?.('generate');
  const report = await generateReportFromInputs({
    settings,
    goal: structure.goal,
    transcript: sample.transcript,
    dataSlotContext: sample.dataSlotContext,
    // Sample answers cover the questionnaire — no partial-completion caveat in a preview.
    completionPct: 100,
    coverage: sample.coverage,
    demoClientId: null,
    sessionId: `preview:${versionId}`,
    // Marks the method record as a sample run, so neither the explainer agent nor the deterministic
    // template can describe it as having read a real respondent's answers.
    preview: true,
    ...(onProgress ? { onProgress } : {}),
  });

  return {
    questionnaireTitle: structure.questionnaireTitle,
    mode: settings.mode,
    content: report.content,
    formatted: report.formatted,
    completionPct: report.completionPct,
  };
}

export interface StreamReportPreviewParams extends Omit<RunReportPreviewParams, 'onProgress'> {
  /** Log context — the questionnaire the version belongs to. */
  questionnaireId: string;
  /** Admin who triggered the preview (owns the spend). */
  adminId: string;
}

/**
 * Drive a preview as an SSE event stream: an opening `started`, a phase event per boundary, then a
 * terminal `done` carrying the rendered report or `error`. Never throws — a terminal failure is
 * logged here and surfaces as the `error` event, because once the response has switched to
 * `text/event-stream` there is no status code left to fail with.
 */
export async function* streamReportPreview(
  params: StreamReportPreviewParams
): AsyncGenerator<ReportPreviewEvent> {
  const { structure, settings, versionId, questionnaireId, adminId } = params;
  const counts = previewStructureCounts(structure);

  yield { type: 'started', ...counts };

  let stage: PreviewStage = 'sample';
  const channel = createProgressChannel<ReportPreviewEvent>();
  const run = runReportPreview({
    structure,
    settings,
    versionId,
    onProgress: channel.emit,
    onStage: (s) => {
      stage = s;
    },
  });

  try {
    // `drain` yields each phase event as it is emitted and finally returns the run's own result, so
    // the fan-out's progress reaches the admin while the run is still in flight.
    const payload = yield* channel.drain(run);
    logger.info('Report preview generated', {
      adminId,
      questionnaireId,
      versionId,
      mode: settings.mode,
    });
    yield { type: 'done', ...payload };
  } catch (err) {
    const refusal = classifyPreviewFailure(err);
    logger.error('Report preview failed', {
      adminId,
      questionnaireId,
      versionId,
      stage,
      timedOut: refusal.code === 'REPORT_PREVIEW_TIMEOUT',
      error: errorMessage(err),
    });
    yield { type: 'error', code: refusal.code, message: refusal.message };
  }
}
