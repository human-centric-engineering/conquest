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
 * Enqueue the RUN-level report for a concluded experience run (F15.4b).
 *
 * Called from the `conclude` path — the one place a journey is known to be over. Until this
 * existed, the handoff card's "See your summary" pointed at the last leg's own report, which
 * described one questionnaire rather than the journey the respondent actually took.
 *
 * ## Which leg's settings govern
 *
 * The ENTRY leg's version config, not the last leg's. A run spans several versions, so something
 * has to arbitrate, and the entry leg is the only leg every run has. Anchoring on the last leg
 * would mean two respondents on the same experience receive differently-styled reports purely
 * because the selector routed them differently — a difference the author never asked for and
 * cannot easily predict.
 *
 * Idempotent on `runId`: `advanceExperienceRun` can be raced by `after()`, a double-tapped submit
 * and a cron retry, exactly as the handoff itself can.
 */
export async function enqueueRunReport(runId: string): Promise<boolean> {
  const entryLeg = await prisma.appExperienceRunLeg.findFirst({
    where: { runId },
    orderBy: { ordinal: 'asc' },
    select: { sessionId: true },
  });
  if (!entryLeg) return false;

  const meta = await prisma.appQuestionnaireSession.findUnique({
    where: { id: entryLeg.sessionId },
    select: { version: { select: { config: { select: { respondentReport: true } } } } },
  });
  const settings = narrowRespondentReportSettings(meta?.version?.config?.respondentReport);
  if (!settings.enabled || !isAiRespondentReportMode(settings.mode)) return false;

  await prisma.appRespondentReport.upsert({
    where: { runId },
    create: { runId, subjectKind: 'experience_run', mode: settings.mode, status: 'queued' },
    // Idempotent: a concurrent advance must not reset an already-generated report.
    update: {},
  });
  return true;
}

/**
 * Whether this session is a leg of an experience run — i.e. whether its own per-session report
 * should be SKIPPED in favour of the run-level one.
 *
 * Generating both would bill the respondent's journey twice over and hand them n+1 reports where
 * they were promised one summary. The run report covers every leg, including this one.
 *
 * The cost of skipping is that an ABANDONED run yields no report at all. That is the same outcome
 * as abandoning a standalone questionnaire, so it introduces no new failure mode — and a run that
 * concludes for any reason (including budget exhaustion) does enqueue one.
 */
export async function isExperienceLeg(sessionId: string): Promise<boolean> {
  const leg = await prisma.appExperienceRunLeg.findUnique({
    where: { sessionId },
    select: { id: true },
  });
  return leg !== null;
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
