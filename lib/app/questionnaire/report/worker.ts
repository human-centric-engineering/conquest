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
import {
  generateRespondentReport,
  generateRespondentReportWithSettings,
} from '@/lib/app/questionnaire/report/generate';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import { generateRunReport } from '@/lib/app/questionnaire/report/run-report';
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
  /**
   * Terminal writes skipped because the row's `generation` moved on mid-flight (a respondent
   * reopened and re-finished, force-requeuing the row, while this claim's generation was still
   * running) — see {@link ClaimedReport.generation}. Expected/benign, not a failure: the row is
   * left at its bumped `generation`, `status: 'queued'` state and gets picked up fresh on the
   * next tick.
   */
  superseded: number;
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

/**
 * A claimed report row — enough to generate + (optionally) email on completion.
 *
 * The owner is polymorphic (F15.4b): exactly one of `sessionId` / `runId` is set. `driveReport`
 * branches on which, so a run report and a session report share one queue, one lease and one
 * worker tick rather than growing a second parallel pipeline.
 */
interface ClaimedReport {
  id: string;
  sessionId: string | null;
  /** Set for a run-level report spanning every leg of an experience run. */
  runId: string | null;
  /** Respondent opted in to a report-ready email; null when they didn't. */
  notifyEmail: string | null;
  /**
   * Monotonic fence (F-early-finish-reopen): bumped by `enqueueOrRegenerateRespondentReport`
   * every time an already-delivered report is force-requeued. The terminal writes below guard on
   * this value so a stale write from a SUPERSEDED claim (the respondent reopened and re-finished
   * while this generation was still in flight) can never clobber the fresh regenerate.
   */
  generation: number;
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
    select: { id: true, sessionId: true, runId: true, notifyEmail: true, generation: true },
  });
}

/** Generate + persist one claimed report. */
async function driveReport(claimed: ClaimedReport): Promise<'succeeded' | 'failed' | 'superseded'> {
  try {
    // Which generator depends on what the report is ABOUT. Both return the identical shape and
    // both run the same downstream pipeline (KB grounding, research rounds, formatter, method
    // record) — a run report differs only in assembling its inputs from several legs.
    const generated = claimed.runId
      ? await generateRunReport(claimed.runId)
      : claimed.sessionId
        ? await generateRespondentReport(claimed.sessionId)
        : null;
    if (!generated) {
      // A row with neither owner set cannot be generated and never will be. Fail it terminally
      // rather than letting it be re-claimed on every tick forever.
      throw new Error('Report row has no session or run owner');
    }
    const { content, costUsd, formatted, completionPct, methodRecord } = generated;
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
    const readyWrite = await prisma.appRespondentReport.updateMany({
      // The `generation` guard is the fence: if a reopen-then-refinish force-requeued this row
      // (bumping `generation`, flipping `status` back to `queued`) while this claim was still
      // generating, this write must NOT land — it would clobber the fresh regenerate with stale
      // content. `status: 'processing'` alone can't catch this: a requeue-then-reclaim on the SAME
      // worker tick could plausibly find `processing` again before this write runs.
      where: { id: claimed.id, status: 'processing', generation: claimed.generation },
      data: {
        status: 'ready',
        content,
        formatted,
        completionPct,
        costUsd,
        // `?? undefined` (not null): Prisma rejects a literal null for a Json column, and the
        // `as unknown as` cast below would hide it until runtime. Undefined leaves it unset.
        methodRecord: methodRecord ?? undefined,
        generatedAt: new Date(),
        error: null,
        lockedBy: null,
        lockedAt: null,
        // Clear the notify request now it's been (or is about to be) satisfied — a later re-drain
        // of this row must not re-send the email.
        notifyEmail: null,
      } as unknown as ReportUpdateData,
    });
    if (readyWrite.count === 0) {
      // Superseded, not failed — expected/benign (see ReportWorkerResult.superseded). The row is
      // already back at `queued` with a bumped `generation`, ready for a fresh claim next tick.
      logger.info('respondent report generation superseded by a regenerate', {
        reportId: claimed.id,
        sessionId: claimed.sessionId,
        generation: claimed.generation,
      });
      return 'superseded';
    }
    // Best-effort report-ready email — the report is already saved, so a send failure is logged,
    // never surfaced or retried.
    // Branch on the same polymorphic owner the generator did. A run-scope row has NO sessionId by
    // construction, so addressing the send by session alone silently discarded every run opt-in
    // while the ready-write cleared the address — the respondent was told an email was coming and
    // nothing ever arrived. The null arm is unreachable (an ownerless row threw above); it keeps
    // the branch total rather than reaching for a non-null assertion.
    const subject = claimed.runId
      ? { runId: claimed.runId }
      : claimed.sessionId
        ? { sessionId: claimed.sessionId }
        : null;
    if (notifyEmail && subject) {
      try {
        await sendRespondentReportReadyEmail(subject, notifyEmail);
      } catch (err) {
        logger.warn('respondent report: ready-email send failed', {
          reportId: claimed.id,
          sessionId: claimed.sessionId,
          runId: claimed.runId,
          error: errorMessage(err),
        });
      }
    }
    return 'succeeded';
  } catch (err) {
    logger.error('respondent report generation failed', {
      reportId: claimed.id,
      sessionId: claimed.sessionId,
      error: errorMessage(err),
    });
    const failedWrite = await prisma.appRespondentReport.updateMany({
      // Same generation fence as the ready-write above — a failure from a superseded claim must
      // not stamp `failed` over a row a regenerate already moved past.
      where: { id: claimed.id, status: 'processing', generation: claimed.generation },
      data: {
        status: 'failed',
        error: errorMessage(err).slice(0, ERROR_MAX),
        lockedBy: null,
        lockedAt: null,
      },
    });
    if (failedWrite.count === 0) return 'superseded';
    return 'failed';
  }
}

/**
 * Drain queued respondent reports for this tick. Claims up to {@link MAX_PER_TICK} within
 * {@link TICK_BUDGET_MS}; stops early when nothing is claimable.
 */
export async function processQueuedRespondentReports(): Promise<ReportWorkerResult> {
  const workerId = `report-worker:${crypto.randomUUID()}`;
  const deadline = Date.now() + TICK_BUDGET_MS;
  const out: ReportWorkerResult = { claimed: 0, succeeded: 0, failed: 0, superseded: 0 };

  while (out.claimed < MAX_PER_TICK && Date.now() < deadline) {
    const claimed = await claimNextReport(workerId);
    if (!claimed) break;
    out.claimed += 1;
    const outcome = await driveReport(claimed);
    if (outcome === 'succeeded') out.succeeded += 1;
    else if (outcome === 'failed') out.failed += 1;
    else out.superseded += 1;
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

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * Admin re-run revisions (report/revision.ts) — a SEPARATE queue drained the same way.
 *
 * An admin re-run appends a `queued` AppRespondentReportRevision carrying its own settings snapshot;
 * this drains it exactly like the delivered report (same lease/claim idempotency) but generates with
 * `generateRespondentReportWithSettings` (the snapshot settings, not the version config) and writes the
 * result onto the REVISION — never the delivered report. Promoting a revision into the delivered report
 * is a separate, explicit admin action (`promoteRespondentReportRevision`).
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** A claimed revision row — enough to generate its report with the snapshot settings. */
interface ClaimedRevision {
  id: string;
  /**
   * Null when the parent report is RUN-scoped (F15.4b). Admin re-runs are a per-session affordance
   * today, so such a revision cannot currently be created — this is defensive, not a live path.
   * `driveRevision` fails it terminally rather than crashing the whole tick.
   */
  sessionId: string | null;
  settingsSnapshot: unknown;
}

/** Atomically claim the oldest claimable revision. Returns the claimed row, or null. */
async function claimNextRevision(workerId: string): Promise<ClaimedRevision | null> {
  const orphanCutoff = new Date(Date.now() - REPORT_LEASE_TTL_MS);

  const candidate = await prisma.appRespondentReportRevision.findFirst({
    where: claimableWhere(orphanCutoff),
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!candidate) return null;

  const result = await prisma.appRespondentReportRevision.updateMany({
    where: { id: candidate.id, ...claimableWhere(orphanCutoff) },
    data: { status: 'processing', lockedBy: workerId, lockedAt: new Date() },
  });
  if (result.count === 0) return null; // another worker won the race

  const row = await prisma.appRespondentReportRevision.findUnique({
    where: { id: candidate.id },
    select: { id: true, settingsSnapshot: true, report: { select: { sessionId: true } } },
  });
  if (!row) return null;
  return { id: row.id, sessionId: row.report.sessionId, settingsSnapshot: row.settingsSnapshot };
}

/** Prisma's `updateMany` data input for the revision model (keeps this module `@prisma/client`-free). */
type RevisionUpdateData = Parameters<
  typeof prisma.appRespondentReportRevision.updateMany
>[0]['data'];

/** Generate + persist one claimed revision. Returns whether it succeeded. */
async function driveRevision(claimed: ClaimedRevision): Promise<boolean> {
  try {
    const settings = narrowRespondentReportSettings(claimed.settingsSnapshot);
    if (!claimed.sessionId) {
      // Re-running a RUN-scoped report is not supported yet. Fail terminally so the row does not
      // sit in the queue being re-claimed on every tick forever.
      throw new Error('Re-running a run-scoped report is not supported');
    }
    const { content, costUsd, formatted, completionPct, methodRecord } =
      await generateRespondentReportWithSettings(claimed.sessionId, settings);
    await prisma.appRespondentReportRevision.updateMany({
      where: { id: claimed.id, status: 'processing' },
      data: {
        status: 'ready',
        content,
        formatted,
        completionPct,
        costUsd,
        // `?? undefined` (not null): Prisma rejects a literal null for a Json column, and the
        // `as unknown as` cast below would hide it until runtime. Undefined leaves it unset.
        methodRecord: methodRecord ?? undefined,
        generatedAt: new Date(),
        error: null,
        lockedBy: null,
        lockedAt: null,
      } as unknown as RevisionUpdateData,
    });
    return true;
  } catch (err) {
    logger.error('respondent report revision generation failed', {
      revisionId: claimed.id,
      sessionId: claimed.sessionId,
      error: errorMessage(err),
    });
    await prisma.appRespondentReportRevision.updateMany({
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
 * Drain queued admin re-run revisions for this tick. Same batch/budget/lease discipline as
 * {@link processQueuedRespondentReports}; kept as its own drain so a delivered-report backlog and a
 * re-run backlog never starve each other within a tick.
 */
export async function processQueuedReportRevisions(): Promise<ReportWorkerResult> {
  const workerId = `report-revision-worker:${crypto.randomUUID()}`;
  const deadline = Date.now() + TICK_BUDGET_MS;
  // Revisions have no generation fence (only the delivered report does) — `superseded` stays 0.
  const out: ReportWorkerResult = { claimed: 0, succeeded: 0, failed: 0, superseded: 0 };

  while (out.claimed < MAX_PER_TICK && Date.now() < deadline) {
    const claimed = await claimNextRevision(workerId);
    if (!claimed) break;
    out.claimed += 1;
    const ok = await driveRevision(claimed);
    if (ok) out.succeeded += 1;
    else out.failed += 1;
  }

  if (out.claimed >= MAX_PER_TICK) {
    const backlog = await prisma.appRespondentReportRevision.count({
      where: { status: { in: ['queued', 'processing'] } },
    });
    if (backlog >= BACKLOG_WARN_THRESHOLD) {
      logger.warn('respondent report revision backlog', { backlog, drainedThisTick: out.claimed });
    }
  }

  return out;
}
