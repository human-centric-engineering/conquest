/**
 * Respondent Report generation worker.
 *
 * Called once per maintenance-tick from the background chain in
 * `lib/orchestration/maintenance/run-tick.ts` (NEVER awaited on the HTTP path). Drains up to a small
 * batch of `queued` reports per tick under a wall-clock budget so a backlog clears without stalling
 * the tick. Crash-safe via a lease (`lockedBy`/`lockedAt`): a row whose lease is stale (worker
 * crashed mid-generation) is re-claimable on a later tick. The claim is a single conditional UPDATE,
 * so two concurrent workers can never both hold the same row — mirrors the evaluations batch worker
 * (lib/orchestration/evaluations/run-claim.ts).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { generateRespondentReport } from '@/lib/app/questionnaire/report/generate';
import { sendRespondentReportReadyEmail } from '@/lib/app/questionnaire/report/notify-send';

/**
 * Prisma's `updateMany` data input for this model, derived from the client value so lib/app stays
 * storage-agnostic (no `@prisma/client` import). Used to land the generated content into the Json
 * column without a `Prisma.InputJsonValue` import.
 */
type ReportUpdateData = Parameters<typeof prisma.appRespondentReport.updateMany>[0]['data'];

/** Lease TTL — a `processing` row whose lock is older than this is treated as orphaned. */
export const REPORT_LEASE_TTL_MS = 5 * 60 * 1000;
/** Max reports drained per tick (each is one LLM call). */
const MAX_PER_TICK = 5;
/** Warn (ops signal) when this many reports are still waiting after a full-batch tick. */
const BACKLOG_WARN_THRESHOLD = 20;
/** Wall-clock budget per tick — stop claiming new work past this even if more is queued. */
const TICK_BUDGET_MS = 45_000;
/** Cap the stored failure message. */
const ERROR_MAX = 1000;

export interface ReportWorkerResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The claim predicate: a fresh queued row, or an orphaned `processing` row whose lease has gone
 * stale (the worker crashed mid-generation). Unlike the evaluations worker, this one never releases
 * a lease mid-flight — it runs each report to a terminal state in one go — so there is no
 * `processing + lockedBy: null` (intentionally-released) case to re-claim.
 */
function claimableWhere(orphanCutoff: Date) {
  return {
    OR: [
      { status: 'queued', lockedBy: null },
      { status: 'processing', lockedAt: { lt: orphanCutoff } },
    ],
  };
}

/** A claimed report row — enough to generate + (optionally) email on completion. */
interface ClaimedReport {
  id: string;
  sessionId: string;
  /** Respondent opted in to a report-ready email; null when they didn't. */
  notifyEmail: string | null;
}

/** Atomically claim the oldest claimable report. Returns the claimed row, or null. */
async function claimNextReport(workerId: string): Promise<ClaimedReport | null> {
  const orphanCutoff = new Date(Date.now() - REPORT_LEASE_TTL_MS);

  const candidate = await prisma.appRespondentReport.findFirst({
    where: claimableWhere(orphanCutoff),
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return null;

  const result = await prisma.appRespondentReport.updateMany({
    where: { id: candidate.id, ...claimableWhere(orphanCutoff) },
    data: { status: 'processing', lockedBy: workerId, lockedAt: new Date() },
  });
  if (result.count === 0) return null; // another worker won the race

  return prisma.appRespondentReport.findUnique({
    where: { id: candidate.id },
    select: { id: true, sessionId: true, notifyEmail: true },
  });
}

/** Generate + persist one claimed report. Returns whether it succeeded. */
async function driveReport(claimed: ClaimedReport): Promise<boolean> {
  try {
    const { content, costUsd, formatted, completionPct } = await generateRespondentReport(
      claimed.sessionId
    );
    // Re-read notifyEmail: generation takes tens of seconds, during which the respondent may have
    // just opted in (the notify route matches `processing` rows). Using the claim-time value would
    // miss that late opt-in AND the ready-write below clears the column — so read the fresh value
    // now and decide the send on it. (`?? claimed.notifyEmail` keeps a claim-time value if the
    // re-read races/returns nothing.)
    const fresh = await prisma.appRespondentReport.findUnique({
      where: { id: claimed.id },
      select: { notifyEmail: true },
    });
    const notifyEmail = fresh?.notifyEmail ?? claimed.notifyEmail;
    await prisma.appRespondentReport.updateMany({
      where: { id: claimed.id, status: 'processing' },
      data: {
        status: 'ready',
        content,
        formatted,
        completionPct,
        costUsd,
        generatedAt: new Date(),
        error: null,
        lockedBy: null,
        lockedAt: null,
        // Clear the notify request now it's been (or is about to be) satisfied — a later re-drain
        // of this row must not re-send the email.
        notifyEmail: null,
      } as unknown as ReportUpdateData,
    });
    // Best-effort report-ready email — the report is already saved, so a send failure is logged,
    // never surfaced or retried.
    if (notifyEmail) {
      try {
        await sendRespondentReportReadyEmail(claimed.sessionId, notifyEmail);
      } catch (err) {
        logger.warn('respondent report: ready-email send failed', {
          reportId: claimed.id,
          sessionId: claimed.sessionId,
          error: errorMessage(err),
        });
      }
    }
    return true;
  } catch (err) {
    logger.error('respondent report generation failed', {
      reportId: claimed.id,
      sessionId: claimed.sessionId,
      error: errorMessage(err),
    });
    await prisma.appRespondentReport.updateMany({
      where: { id: claimed.id, status: 'processing' },
      data: {
        status: 'failed',
        error: errorMessage(err).slice(0, ERROR_MAX),
        lockedBy: null,
        lockedAt: null,
      },
    });
    return false;
  }
}

/**
 * Drain queued respondent reports for this tick. Claims up to {@link MAX_PER_TICK} within
 * {@link TICK_BUDGET_MS}; stops early when nothing is claimable.
 */
export async function processQueuedRespondentReports(): Promise<ReportWorkerResult> {
  const workerId = `report-worker:${crypto.randomUUID()}`;
  const deadline = Date.now() + TICK_BUDGET_MS;
  const out: ReportWorkerResult = { claimed: 0, succeeded: 0, failed: 0 };

  while (out.claimed < MAX_PER_TICK && Date.now() < deadline) {
    const claimed = await claimNextReport(workerId);
    if (!claimed) break;
    out.claimed += 1;
    const ok = await driveReport(claimed);
    if (ok) out.succeeded += 1;
    else out.failed += 1;
  }

  // Ops signal: if we filled the batch there may be a backlog. Count what's still waiting so a
  // stuck/oversized queue is visible (e.g. the cron isn't firing, or generation is failing).
  if (out.claimed >= MAX_PER_TICK) {
    const backlog = await prisma.appRespondentReport.count({
      where: { status: { in: ['queued', 'processing'] } },
    });
    if (backlog >= BACKLOG_WARN_THRESHOLD) {
      logger.warn('respondent report backlog', { backlog, drainedThisTick: out.claimed });
    }
  }

  return out;
}
