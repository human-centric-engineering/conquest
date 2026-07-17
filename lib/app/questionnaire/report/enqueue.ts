/**
 * Respondent Report enqueue — the submit-time trigger.
 *
 * Called after a session is marked completed. Creates a `queued` `AppRespondentReport` row ONLY when
 * the platform flag is on AND the version's config has the report enabled in an AI mode
 * (`raw_plus_insights` or `narrative`) — the raw-only mode renders on demand and needs no row, and no
 * row means no generation work. Idempotent: a double-submit / re-submit upserts without resetting an
 * existing report. The maintenance-tick worker picks the row up; this never blocks or fails submission.
 */

import { prisma } from '@/lib/db/client';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import { isAiRespondentReportMode } from '@/lib/app/questionnaire/types';

/**
 * Enqueue a respondent report for a just-completed session. Returns `true` when a row was ensured,
 * `false` when the feature is off / the version isn't in insights mode (the common case).
 */
export async function enqueueRespondentReport(sessionId: string): Promise<boolean> {
  const meta = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: { version: { select: { config: { select: { respondentReport: true } } } } },
  });
  const settings = narrowRespondentReportSettings(meta?.version?.config?.respondentReport);
  if (!settings.enabled || !isAiRespondentReportMode(settings.mode)) return false;

  await prisma.appRespondentReport.upsert({
    where: { sessionId },
    create: { sessionId, mode: settings.mode, status: 'queued' },
    // Idempotent: a re-submit must not reset an already-generated (or in-flight) report.
    update: {},
  });
  return true;
}
