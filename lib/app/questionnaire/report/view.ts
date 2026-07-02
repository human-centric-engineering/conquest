/**
 * Respondent Report — the respondent-facing view (completion screen + report endpoint).
 *
 * Resolves what a respondent should see after completing: whether a report is enabled (config AND
 * platform flag), its mode + delivery, and — for the AI modes (`raw_plus_insights`, `narrative`) — the
 * generation status and content (from `AppRespondentReport`). Raw mode and disabled reports carry
 * `insights: null`. Pure data assembly behind a mockable seam; the endpoint adds access control.
 */

import { prisma } from '@/lib/db/client';
import { isFeatureEnabled } from '@/lib/feature-flags';
import {
  APP_QUESTIONNAIRES_FLAG,
  APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG,
} from '@/lib/app/questionnaire/constants';
import {
  isAiRespondentReportMode,
  type RespondentReportMode,
  type RespondentReportStatus,
} from '@/lib/app/questionnaire/types';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import {
  validateRespondentReportContent,
  type RespondentReportContent,
} from '@/lib/app/questionnaire/report/content';

/** The respondent-facing report state for one session. */
export interface RespondentReportClientView {
  enabled: boolean;
  mode: RespondentReportMode;
  onScreen: boolean;
  download: boolean;
  /** The questionnaire's title — so the completion screen can name the PDF download after it. */
  questionnaireTitle: string;
  /** Insights state for the AI modes (`raw_plus_insights`, `narrative`); `null` for raw / disabled. */
  insights: {
    status: RespondentReportStatus;
    /**
     * Whether a report row actually exists yet. `status` reads as `'queued'` both when a row is
     * genuinely queued AND when no row exists yet (never enqueued / not yet claimed) — this flag
     * disambiguates so the UI can distinguish "starting" (no row) from "preparing" (row queued).
     */
    started: boolean;
    content: RespondentReportContent | null;
    generatedAt: string | null;
    error: string | null;
    /** Whether the respondent has opted in to an email when the report is ready. */
    notifyRequested: boolean;
  } | null;
}

/**
 * Build the respondent-facing report view for a session. Returns `null` when the session doesn't
 * exist. `enabled` reflects both the per-version config AND the platform flag, so a respondent never
 * waits on a report the platform has turned off.
 */
export async function buildRespondentReportClientView(
  sessionId: string
): Promise<RespondentReportClientView | null> {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      version: {
        select: {
          config: { select: { respondentReport: true } },
          questionnaire: { select: { title: true } },
        },
      },
      respondentReport: {
        select: { status: true, content: true, generatedAt: true, error: true, notifyEmail: true },
      },
    },
  });
  if (!session) return null;

  const [master, sub] = await Promise.all([
    isFeatureEnabled(APP_QUESTIONNAIRES_FLAG),
    isFeatureEnabled(APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG),
  ]);
  const settings = narrowRespondentReportSettings(session.version?.config?.respondentReport);
  const enabled = master && sub && settings.enabled;

  const base = {
    enabled,
    mode: settings.mode,
    onScreen: settings.delivery.onScreen,
    download: settings.delivery.download,
    questionnaireTitle: session.version?.questionnaire?.title ?? 'questionnaire',
  };

  if (!enabled || !isAiRespondentReportMode(settings.mode)) {
    return { ...base, insights: null };
  }

  const row = session.respondentReport;
  return {
    ...base,
    insights: {
      // No row yet (submitted, worker hasn't claimed it) reads as still-queued.
      status: (row?.status as RespondentReportStatus | undefined) ?? 'queued',
      started: row != null,
      content: row?.content ? validateRespondentReportContent(row.content) : null,
      generatedAt: row?.generatedAt ? row.generatedAt.toISOString() : null,
      error: row?.error ?? null,
      notifyRequested: Boolean(row?.notifyEmail),
    },
  };
}
