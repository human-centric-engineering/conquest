/**
 * Respondent Report revisions — the admin "re-run report" model.
 *
 * An admin looks up a real session (by support reference) and re-runs its respondent report, optionally
 * with new instructions/settings. Every re-run appends an {@link AppRespondentReportRevision} (never
 * mutates one), carrying the exact `settingsSnapshot` it used, so the admin keeps a full, comparable
 * history and can PROMOTE any `ready` revision into the delivered `AppRespondentReport` (what the
 * respondent sees). Generation itself is ASYNC — {@link enqueueRespondentReportRevision} only queues a
 * revision row; the maintenance-tick worker (`report/worker.ts`) drives it via the shared generation
 * core with the snapshot settings.
 *
 * Server-side (touches Prisma) — the sibling of `cohort-report/persist.ts`, whose append-only revision
 * model this mirrors.
 */

import { prisma } from '@/lib/db/client';
import type { Prisma } from '@prisma/client';
// The DB-NULL sentinel comes from `lib/db` rather than `@prisma/client`: `lib/app/**` is the
// fork-extension surface and must not take a runtime Prisma dependency (see eslint.config.mjs).
import { DB_JSON_NULL } from '@/lib/db/json';

import {
  RESPONDENT_REPORT_AUTHORS,
  RESPONDENT_REPORT_RERUN_NOTE_MAX_LENGTH,
  RESPONDENT_REPORT_STATUSES,
  narrowToEnum,
  type RespondentReportAuthor,
  type RespondentReportMode,
  type RespondentReportSettings,
  type RespondentReportStatus,
} from '@/lib/app/questionnaire/types';
import { narrowRespondentReportSettings } from '@/lib/app/questionnaire/report/settings';
import {
  validateRespondentReportContent,
  type RespondentReportContent,
} from '@/lib/app/questionnaire/report/content';

/** One revision's metadata for the admin history list (client-safe; no heavy `content`). */
export interface RespondentReportRevisionSummary {
  id: string;
  revisionNumber: number;
  status: RespondentReportStatus;
  authoredBy: RespondentReportAuthor;
  /** The admin's short note for this re-run, or null. */
  instructions: string | null;
  /** The report mode this re-run used (from its settings snapshot). */
  mode: RespondentReportMode;
  completionPct: number | null;
  costUsd: number | null;
  error: string | null;
  generatedAt: string | null;
  createdAt: string;
  /** True when this revision's content is the one currently promoted to the delivered report. */
  delivered: boolean;
}

/** The delivered-report header state the admin panel shows alongside the revision history. */
export interface DeliveredReportSummary {
  status: RespondentReportStatus;
  /** Whether the delivered report actually has content yet. */
  hasContent: boolean;
  generatedAt: string | null;
  /** The revision id last promoted into the delivered report; null = original submit-time generation. */
  deliveredRevisionId: string | null;
}

/** The full admin re-run view for one session: the delivered report + the re-run history. */
export interface RespondentReportRevisionsView {
  delivered: DeliveredReportSummary | null;
  revisions: RespondentReportRevisionSummary[];
}

function toSummary(
  row: {
    id: string;
    revisionNumber: number;
    status: string;
    authoredBy: string;
    instructions: string | null;
    settingsSnapshot: Prisma.JsonValue;
    completionPct: number | null;
    costUsd: number | null;
    error: string | null;
    generatedAt: Date | null;
    createdAt: Date;
  },
  deliveredRevisionId: string | null
): RespondentReportRevisionSummary {
  return {
    id: row.id,
    revisionNumber: row.revisionNumber,
    status: narrowToEnum(row.status, RESPONDENT_REPORT_STATUSES, 'queued'),
    authoredBy: narrowToEnum(row.authoredBy, RESPONDENT_REPORT_AUTHORS, 'admin'),
    instructions: row.instructions,
    mode: narrowRespondentReportSettings(row.settingsSnapshot).mode,
    completionPct: row.completionPct,
    costUsd: row.costUsd,
    error: row.error,
    generatedAt: row.generatedAt ? row.generatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    delivered: deliveredRevisionId != null && row.id === deliveredRevisionId,
  };
}

/**
 * Ensure the 1:1 delivered-report header exists for a session so revisions can attach; returns its id.
 * Idempotent — `update: {}` never clobbers an existing header's delivered status/content.
 *
 * When a header must be CREATED (a session that never got a report — raw mode, disabled at submit, or
 * feature off), it is created `ready` with null content, NOT `queued`: a `queued` header would be
 * claimed by the delivered-report worker and generate an (unwanted) delivered report from the version
 * config. `ready`-with-null-content is inert — the delivered worker skips it, and the respondent view
 * only ever reads the header when the version config enables an AI-mode report, in which case the
 * submit-time enqueue already created the header (so this create branch never applies there).
 */
export async function ensureRespondentReportHeader(
  sessionId: string,
  mode: RespondentReportMode
): Promise<string> {
  const row = await prisma.appRespondentReport.upsert({
    where: { sessionId },
    create: { sessionId, mode, status: 'ready' },
    update: {},
    select: { id: true },
  });
  return row.id;
}

/**
 * Queue an admin re-run of a session's respondent report with explicit settings. Appends the next
 * revision (monotonic `revisionNumber`) in `queued` status; the maintenance worker generates it. The
 * `settings` are the (already-narrowed) instructions/config this run should use. Returns the new
 * revision's number + id.
 */
export async function enqueueRespondentReportRevision(params: {
  sessionId: string;
  settings: RespondentReportSettings;
  instructions?: string | null;
  adminId: string;
}): Promise<{ revisionNumber: number; revisionId: string }> {
  const { sessionId, settings, instructions, adminId } = params;
  const reportId = await ensureRespondentReportHeader(sessionId, settings.mode);
  const note = instructions?.trim().slice(0, RESPONDENT_REPORT_RERUN_NOTE_MAX_LENGTH) || null;

  return prisma.$transaction(async (tx) => {
    // Snapshot the currently-delivered (original) report as revision 0 the first time a re-run is
    // queued — a promote would otherwise overwrite it, and the admin must be able to revert to / diff
    // against the original. Idempotent + no-op when there is no delivered content to preserve.
    await ensureOriginalBaselineRevisionTx(tx, reportId);

    const last = await tx.appRespondentReportRevision.findFirst({
      where: { reportId },
      orderBy: { revisionNumber: 'desc' },
      select: { revisionNumber: true },
    });
    const revisionNumber = (last?.revisionNumber ?? 0) + 1;

    const created = await tx.appRespondentReportRevision.create({
      data: {
        reportId,
        revisionNumber,
        status: 'queued',
        settingsSnapshot: settings,
        instructions: note,
        authoredBy: 'admin',
        createdBy: adminId,
      },
      select: { id: true },
    });

    return { revisionNumber, revisionId: created.id };
  });
}

/**
 * Capture the currently-delivered report as **revision 0** — the immutable "Original" baseline the admin
 * can revert to and diff against. Idempotent (skips when revision 0 already exists) and a no-op when the
 * header has no delivered content yet (nothing to preserve). Runs inside the enqueue transaction so the
 * baseline is snapshotted before the first re-run can ever be promoted over the original.
 */
async function ensureOriginalBaselineRevisionTx(
  tx: Prisma.TransactionClient,
  reportId: string
): Promise<void> {
  const existing = await tx.appRespondentReportRevision.findUnique({
    where: { reportId_revisionNumber: { reportId, revisionNumber: 0 } },
    select: { id: true },
  });
  if (existing) return;

  const header = await tx.appRespondentReport.findUnique({
    where: { id: reportId },
    select: { content: true, formatted: true, completionPct: true, mode: true, generatedAt: true },
  });
  if (!header || header.content == null) return;

  await tx.appRespondentReportRevision.create({
    data: {
      reportId,
      revisionNumber: 0,
      status: 'ready',
      content: header.content ?? undefined,
      formatted: header.formatted,
      completionPct: header.completionPct,
      // Minimal snapshot — only `.mode` is read back (for the history label); the original was AI-authored.
      settingsSnapshot: { mode: header.mode },
      instructions: null,
      authoredBy: 'ai',
      createdBy: null,
      generatedAt: header.generatedAt ?? new Date(),
    },
  });
}

/**
 * Build the admin re-run view for a session: the delivered-report header summary + every revision
 * (newest first). Returns `{ delivered: null, revisions: [] }` when the session has no report header
 * yet (never re-run and never reported).
 */
export async function getRespondentReportRevisionsView(
  sessionId: string
): Promise<RespondentReportRevisionsView> {
  const header = await prisma.appRespondentReport.findUnique({
    where: { sessionId },
    select: {
      id: true,
      status: true,
      content: true,
      generatedAt: true,
      deliveredRevisionId: true,
    },
  });
  if (!header) return { delivered: null, revisions: [] };

  const rows = await prisma.appRespondentReportRevision.findMany({
    where: { reportId: header.id },
    orderBy: { revisionNumber: 'desc' },
    select: {
      id: true,
      revisionNumber: true,
      status: true,
      authoredBy: true,
      instructions: true,
      settingsSnapshot: true,
      completionPct: true,
      costUsd: true,
      error: true,
      generatedAt: true,
      createdAt: true,
    },
  });

  return {
    delivered: {
      status: narrowToEnum(header.status, RESPONDENT_REPORT_STATUSES, 'queued'),
      hasContent: header.content != null,
      generatedAt: header.generatedAt ? header.generatedAt.toISOString() : null,
      deliveredRevisionId: header.deliveredRevisionId,
    },
    revisions: rows.map((r) => toSummary(r, header.deliveredRevisionId)),
  };
}

/** One revision's full content for the admin viewer's "View" dialog. */
export interface RespondentReportRevisionDetail {
  revisionNumber: number;
  status: RespondentReportStatus;
  mode: RespondentReportMode;
  instructions: string | null;
  content: RespondentReportContent | null;
  formatted: boolean;
  completionPct: number | null;
  error: string | null;
}

/** Read one revision's full content (for the admin viewer). Returns null when it doesn't exist. */
export async function getRespondentReportRevisionDetail(
  sessionId: string,
  revisionNumber: number
): Promise<RespondentReportRevisionDetail | null> {
  const header = await prisma.appRespondentReport.findUnique({
    where: { sessionId },
    select: { id: true },
  });
  if (!header) return null;

  const row = await prisma.appRespondentReportRevision.findUnique({
    where: { reportId_revisionNumber: { reportId: header.id, revisionNumber } },
    select: {
      revisionNumber: true,
      status: true,
      instructions: true,
      settingsSnapshot: true,
      content: true,
      formatted: true,
      completionPct: true,
      error: true,
    },
  });
  if (!row) return null;

  return {
    revisionNumber: row.revisionNumber,
    status: narrowToEnum(row.status, RESPONDENT_REPORT_STATUSES, 'queued'),
    mode: narrowRespondentReportSettings(row.settingsSnapshot).mode,
    instructions: row.instructions,
    content: row.content ? validateRespondentReportContent(row.content) : null,
    formatted: row.formatted,
    completionPct: row.completionPct,
    error: row.error,
  };
}

/** Outcome of a promote request. */
export interface PromoteRevisionResult {
  promoted: boolean;
}

/**
 * Promote a `ready` revision into the delivered report: copy its generated content onto the
 * `AppRespondentReport` header so the respondent's on-screen report + downloadable PDF now render it,
 * and record `deliveredRevisionId` so the history marks which re-run is live. A no-op (`promoted:
 * false`) when the header/revision is missing or the revision isn't `ready` with content.
 *
 * Clears any pending `notifyEmail` (the delivered report changed; a stale queued email must not fire)
 * and the lease, exactly like the worker's ready-write.
 */
export async function promoteRespondentReportRevision(params: {
  sessionId: string;
  revisionNumber: number;
}): Promise<PromoteRevisionResult> {
  const { sessionId, revisionNumber } = params;

  const header = await prisma.appRespondentReport.findUnique({
    where: { sessionId },
    select: { id: true },
  });
  if (!header) return { promoted: false };

  const rev = await prisma.appRespondentReportRevision.findUnique({
    where: { reportId_revisionNumber: { reportId: header.id, revisionNumber } },
    select: {
      id: true,
      status: true,
      content: true,
      formatted: true,
      completionPct: true,
      methodRecord: true,
      settingsSnapshot: true,
    },
  });
  if (!rev || rev.status !== 'ready' || rev.content == null) return { promoted: false };

  const mode = narrowRespondentReportSettings(rev.settingsSnapshot).mode;
  // Bind the narrowed (non-null, guarded above) content before the closure — TS drops property
  // narrowing inside a callback since it can't prove `rev` wasn't mutated.
  const promotedContent = rev.content;
  // The method record travels with the content it describes. Leaving the delivered report's old record
  // in place would leave the "How this report was created" panel describing a run that produced
  // different prose — an explanation that is worse than none. `null` for a revision generated before
  // this shipped, which correctly retires the panel for that report rather than mis-describing it.
  // `DbNull` rather than skipping the field: leaving the previous record in place is the one outcome
  // that must not happen, so a record-less revision explicitly clears it.
  const promotedMethodRecord =
    rev.methodRecord == null ? DB_JSON_NULL : (rev.methodRecord as Prisma.InputJsonValue);

  await prisma.$transaction(async (tx) => {
    // LAST SAFE MOMENT to preserve the Original. The enqueue-time snapshot no-ops when the delivered
    // report has no content yet — which happens when the admin queues a re-run while the original is
    // still generating. Without this, the worker later fills in the original and THIS promote would
    // overwrite it with no baseline, permanently losing it (and hiding "Revert to original").
    // Idempotent: skipped once revision 0 exists, so a later promote never mis-captures a promoted
    // re-run as the "Original".
    await ensureOriginalBaselineRevisionTx(tx, header.id);

    await tx.appRespondentReport.update({
      where: { id: header.id },
      data: {
        status: 'ready',
        content: promotedContent,
        formatted: rev.formatted,
        completionPct: rev.completionPct,
        methodRecord: promotedMethodRecord,
        mode,
        generatedAt: new Date(),
        error: null,
        deliveredRevisionId: rev.id,
        lockedBy: null,
        lockedAt: null,
        notifyEmail: null,
      },
    });
  });

  return { promoted: true };
}
