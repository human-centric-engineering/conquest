/**
 * Respondent Report — the respondent-facing view (completion screen + report endpoint).
 *
 * Resolves what a respondent should see after completing: whether a report is enabled (config AND
 * platform flag), its mode + delivery, and — for `raw_plus_insights` — the generation status and
 * content (from `AppRespondentReport`). Raw mode and disabled reports carry `insights: null`. Pure
 * data assembly behind a mockable seam; the endpoint adds access control.
 */

import { prisma } from '@/lib/db/client';
import { isFeatureEnabled } from '@/lib/feature-flags';
import {
  APP_QUESTIONNAIRES_FLAG,
  APP_QUESTIONNAIRES_RESPONDENT_REPORT_FLAG,
} from '@/lib/app/questionnaire/constants';
import type { RespondentReportMode, RespondentReportStatus } from '@/lib/app/questionnaire/types';
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
  /** Insights state for `raw_plus_insights`; `null` for raw mode or when disabled. */
  insights: {
    status: RespondentReportStatus;
    content: RespondentReportContent | null;
    generatedAt: string | null;
    error: string | null;
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
      version: { select: { config: { select: { respondentReport: true } } } },
      respondentReport: {
        select: { status: true, content: true, generatedAt: true, error: true },
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
  };

  if (!enabled || settings.mode !== 'raw_plus_insights') {
    return { ...base, insights: null };
  }

  const row = session.respondentReport;
  return {
    ...base,
    insights: {
      // No row yet (submitted, worker hasn't claimed it) reads as still-queued.
      status: (row?.status as RespondentReportStatus | undefined) ?? 'queued',
      content: row?.content ? validateRespondentReportContent(row.content) : null,
      generatedAt: row?.generatedAt ? row.generatedAt.toISOString() : null,
      error: row?.error ?? null,
    },
  };
}
