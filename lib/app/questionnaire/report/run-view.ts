/**
 * Run-level respondent report — the respondent-facing read view (F15.4b).
 *
 * The sibling of `buildRespondentReportClientView`, for a report about a whole journey rather than
 * one session.
 *
 * ## Why this composes rather than duplicates
 *
 * Everything the completion screen needs EXCEPT the generation state is presentation chrome — the
 * branded header, the questionnaire title, the delivery flags, the `includeData` appendix config.
 * All of it comes from the version config, and a run report already reads its settings from the
 * ENTRY leg's version (see `run-report.ts` for why the entry leg and not the last).
 *
 * So this builds the entry leg's view for the chrome and swaps in the RUN's generation state. That
 * keeps one definition of how a report is presented — a second copy would drift on exactly the
 * details (partial-report caveat thresholds, method-panel gating, formatter honouring) that are
 * easy to get subtly wrong and invisible when wrong.
 */

import { prisma } from '@/lib/db/client';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import { RESPONDENT_REPORT_STATUSES } from '@/lib/app/questionnaire/types';
import {
  buildRespondentReportClientView,
  type RespondentReportClientView,
} from '@/lib/app/questionnaire/report/view';
import { validateRespondentReportContent } from '@/lib/app/questionnaire/report/content';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import { narrowMethodRecord } from '@/lib/app/questionnaire/report/method-record';
import { buildReportMethodView } from '@/lib/app/questionnaire/report/method-view';

/**
 * Build the respondent-facing view for a run's report. `null` when the run doesn't exist or has no
 * legs (nothing to present, and no chrome to present it with).
 */
export async function buildRunReportClientView(
  runId: string
): Promise<RespondentReportClientView | null> {
  const run = await prisma.appExperienceRun.findUnique({
    where: { id: runId },
    select: {
      legs: { orderBy: { ordinal: 'asc' }, take: 1, select: { sessionId: true } },
      report: {
        select: {
          status: true,
          content: true,
          formatted: true,
          completionPct: true,
          methodRecord: true,
          generatedAt: true,
          error: true,
          notifyEmail: true,
        },
      },
    },
  });
  if (!run || run.legs.length === 0) return null;

  // Chrome from the entry leg — the same leg whose config decided the report's settings.
  const base = await buildRespondentReportClientView(run.legs[0].sessionId);
  if (!base) return null;

  // A disabled/raw-mode questionnaire yields `insights: null`, and a run report is never generated
  // in that case either. Pass the chrome through untouched rather than inventing an insights block.
  if (base.insights === null) return base;

  // The method panel is gated on the author's `explainMethod` opt-in, read HERE from the entry
  // leg's config rather than inferred from `base.method`. The base view derives its panel from the
  // entry LEG's own report row — and a leg never has one (`isExperienceLeg` skips per-session
  // enqueue in favour of the run's report), so `base.method` is unconditionally null and reading it
  // would suppress the run's record forever. Same gate, same leg, same setting; just no longer
  // derived from a downstream value that no longer exists. It must stay closed: if the author did
  // not opt in, a run report must not become a way around that.
  const entryMeta = await prisma.appQuestionnaireSession.findUnique({
    where: { id: run.legs[0].sessionId },
    select: { version: { select: { config: { select: { respondentReport: true } } } } },
  });
  const settings = narrowRespondentReportSettings(entryMeta?.version?.config?.respondentReport);

  const report = run.report;
  // Both conditions must hold, exactly as in the base view: the version opted in, AND this RUN
  // recorded how its generation went. `narrowMethodRecord` returns null for an absent, malformed or
  // future-schema record.
  const methodRecord = settings.delivery.explainMethod
    ? narrowMethodRecord(report?.methodRecord)
    : null;

  return {
    ...base,
    insights: {
      status: narrowToEnum(report?.status ?? '', RESPONDENT_REPORT_STATUSES, 'queued'),
      // Distinguishes "no row yet" from "row queued" — the completion screen shows "starting"
      // versus "preparing" on the strength of it.
      started: report !== null && report !== undefined,
      content: report?.content ? validateRespondentReportContent(report.content) : null,
      formatted: report?.formatted ?? false,
      completionPct: report?.completionPct ?? null,
      generatedAt: report?.generatedAt?.toISOString() ?? null,
      error: report?.error ?? null,
      notifyRequested: Boolean(report?.notifyEmail),
    },
    // The RUN's own method record, replacing the entry leg's (which the base view resolved and
    // which no longer exists now that legs do not generate reports).
    method: methodRecord ? buildReportMethodView(methodRecord, 'respondent') : null,
  };
}
