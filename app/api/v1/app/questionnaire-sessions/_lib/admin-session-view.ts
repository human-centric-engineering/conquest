/**
 * Admin session-viewer read seams — the DB reads behind the admin "view a respondent session"
 * surface (look up by support reference, then read the conversation).
 *
 * Two pure-ish reads, both Prisma-backed and admin-route-local (kept out of `lib/app/**`, which is
 * Prisma-free, exactly like {@link loadSessionExport} which this mirrors):
 *
 *  - {@link loadAdminSessionView} — the metadata the viewer page needs to decide read-only vs.
 *    continue (`isPreview`/`status`) and to render its header, with respondent identity redacted in
 *    anonymous mode the SAME way the PDF export redacts it (identity is queried only when NOT
 *    anonymous). The conversation itself is loaded separately via {@link loadTranscript}.
 *  - {@link resolveSessionRefLocation} — resolves a user-entered support reference (`publicRef`) to
 *    the session's location so the lookup UI can navigate to its viewer route. Lightweight (no turns
 *    or eval counts, unlike {@link lookupSessionByRef}); it only needs where to send the admin.
 */

import { prisma } from '@/lib/db/client';
import { SESSION_STATUSES, narrowToEnum, type SessionStatus } from '@/lib/app/questionnaire/types';
import { normalizeSessionRef } from '@/lib/app/questionnaire/session-ref';

/** Metadata for the admin session viewer — gates the surface and renders its header. */
export interface AdminSessionView {
  /** The questionnaire the session's version belongs to (admin ownership check). */
  questionnaireId: string;
  questionnaireTitle: string;
  versionId: string;
  versionNumber: number;
  /** A preview (admin) session is continuable; a real respondent session is read-only. */
  isPreview: boolean;
  status: SessionStatus;
  /** Support reference shown in the header (null for legacy sessions minted before refs). */
  publicRef: string | null;
  anonymous: boolean;
  /** Respondent display name — null in anonymous mode (never even queried), mirroring the export. */
  respondentName: string | null;
}

/**
 * Load the admin viewer's metadata for one session, or `null` when it doesn't exist. Identity
 * redaction mirrors {@link loadSessionExport}: in anonymous mode the respondent's name is never
 * queried, so an anonymous session's viewer carries no identity.
 */
export async function loadAdminSessionView(sessionId: string): Promise<AdminSessionView | null> {
  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      status: true,
      isPreview: true,
      publicRef: true,
      versionId: true,
      respondentUserId: true,
      version: {
        select: {
          versionNumber: true,
          questionnaireId: true,
          config: { select: { anonymousMode: true } },
          questionnaire: { select: { title: true } },
        },
      },
    },
  });
  if (!row) return null;

  const anonymous = row.version.config?.anonymousMode ?? false;

  // Identity is only ever queried when NOT anonymous — the same hard gate the export applies.
  let respondentName: string | null = null;
  if (!anonymous && row.respondentUserId) {
    const user = await prisma.user.findUnique({
      where: { id: row.respondentUserId },
      select: { name: true },
    });
    respondentName = user?.name ?? null;
  }

  return {
    questionnaireId: row.version.questionnaireId,
    questionnaireTitle: row.version.questionnaire.title,
    versionId: row.versionId,
    versionNumber: row.version.versionNumber,
    isPreview: row.isPreview,
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
    publicRef: row.publicRef,
    anonymous,
    respondentName,
  };
}

/** Where a support reference resolves to — enough for the lookup UI to navigate to the viewer. */
export interface SessionRefLocation {
  sessionId: string;
  ref: string;
  questionnaireId: string;
  versionId: string;
  versionNumber: number;
  questionnaireTitle: string;
  isPreview: boolean;
  status: SessionStatus;
}

/**
 * Resolve a user-entered support reference to its session's location, or `null` when no session
 * matches. The ref is normalised forgivingly (folds Crockford look-alikes, strips grouping) by
 * {@link normalizeSessionRef}, so a dash / lower-case / O-for-0 slip still resolves.
 */
export async function resolveSessionRefLocation(
  rawRef: string
): Promise<SessionRefLocation | null> {
  const ref = normalizeSessionRef(rawRef);
  if (!ref) return null;

  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { publicRef: ref },
    select: {
      id: true,
      publicRef: true,
      isPreview: true,
      status: true,
      versionId: true,
      version: {
        select: {
          versionNumber: true,
          questionnaireId: true,
          questionnaire: { select: { title: true } },
        },
      },
    },
  });
  if (!row || !row.publicRef) return null;

  return {
    sessionId: row.id,
    ref: row.publicRef,
    questionnaireId: row.version.questionnaireId,
    versionId: row.versionId,
    versionNumber: row.version.versionNumber,
    questionnaireTitle: row.version.questionnaire.title,
    isPreview: row.isPreview,
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
  };
}
