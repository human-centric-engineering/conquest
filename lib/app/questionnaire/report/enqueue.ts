/**
 * Respondent Report enqueue — the submit-time trigger.
 *
 * Called after a session is marked completed. Creates a `queued` `AppRespondentReport` row ONLY when
 * the version's config has the report enabled in an AI mode
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

/**
 * Admin-triggered "Generate report" for a session that has none yet — force a `queued` delivered report
 * so the worker generates it now (used by the session drawer's Report tab before a report exists).
 * Unlike {@link enqueueRespondentReport} (idempotent submit-time enqueue), this re-queues an inert
 * header (a `ready`-with-null-content placeholder, or a `failed` row) that a plain upsert would leave
 * untouched. Refuses when the feature is off / not an AI mode, when a report already has content, or
 * when generation is actively in flight. Returns `true` when a row was queued.
 */
export async function generateDeliveredRespondentReport(sessionId: string): Promise<boolean> {
  const meta = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: { version: { select: { config: { select: { respondentReport: true } } } } },
  });
  const settings = narrowRespondentReportSettings(meta?.version?.config?.respondentReport);
  if (!settings.enabled || !isAiRespondentReportMode(settings.mode)) return false;

  const existing = await prisma.appRespondentReport.findUnique({
    where: { sessionId },
    select: { status: true, content: true },
  });

  if (!existing) {
    await prisma.appRespondentReport.create({
      data: { sessionId, mode: settings.mode, status: 'queued' },
    });
    return true;
  }

  // Never clobber a report that already has content, nor one actively generating.
  if (
    existing.content != null ||
    existing.status === 'processing' ||
    existing.status === 'queued'
  ) {
    return false;
  }

  await prisma.appRespondentReport.update({
    where: { sessionId },
    data: { status: 'queued', mode: settings.mode, error: null, lockedBy: null, lockedAt: null },
  });
  return true;
}
