/**
 * Respondent cross-device resume — resolve a support reference to a resumable anonymous session.
 *
 * The public `/resume-by-ref` route lets a no-login respondent who has their support code
 * (`publicRef`, e.g. `7F3K-9M2P`) continue an in-progress session from a different device (or after
 * their client-held token expired). This is the read behind it, kept route-local (Prisma-backed,
 * out of the Prisma-free `lib/app/**`) like {@link resolveSessionRefLocation} which it mirrors.
 *
 * SECURITY: the ref is a low-entropy (8-char) code being used as a bearer-ish credential, so this
 * resolves a session ONLY when EVERY guard holds — else `null`, which the route turns into a single
 * generic 404 (never distinguishing "no such ref" from "not resumable", to deny an enumeration
 * oracle). The guards, together, keep the blast radius to exactly what "resume my own anonymous
 * chat" needs:
 *   - `publicRef` matches (forgiving normalisation folds Crockford look-alikes / grouping).
 *   - `respondentUserId === null` — anonymous sessions only. A signed-in respondent's session is
 *     NEVER resumable by a typed ref (their identity is the credential, not the code).
 *   - `invitationId === null` — walk-up sessions only, never a frictionless-invite session. An
 *     invite-bound session already has a STRONGER credential (the private, high-entropy invite link,
 *     which resumes it idempotently), so it must not also be reachable by the low-entropy, deliberately
 *     circulated support code. Same principle as the `respondentUserId` guard: don't let a weaker,
 *     shareable code override a stronger one.
 *   - `isPreview === false` — a real respondent session, never an admin preview run.
 *   - status ∈ {active, paused} — an in-progress session, never a terminal one.
 *   - the version's config has `sessionResumeEnabled` on — the admin opted this questionnaire in.
 * The route additionally hard rate-limits the call to throttle brute-force enumeration.
 *
 * Server-only.
 */

import { prisma } from '@/lib/db/client';
import { SESSION_STATUSES, narrowToEnum, type SessionStatus } from '@/lib/app/questionnaire/types';
import { normalizeSessionRef } from '@/lib/app/questionnaire/session-ref';

/** The resumable session a valid ref resolves to — enough to mint a token and route the client. */
export interface ResumableRefTarget {
  sessionId: string;
  versionId: string;
  ref: string;
  status: SessionStatus;
}

/** The statuses a session may be resumed from — the non-terminal set (mirrors `findResumableSession`). */
const RESUMABLE_STATUSES = ['active', 'paused'] as const;

/**
 * Resolve a user-entered support reference to a resumable anonymous session, or `null` when no
 * session passes every guard (see the module header). The ref is normalised forgivingly by
 * {@link normalizeSessionRef}, so a dash / lower-case / O-for-0 slip still resolves.
 */
export async function resolveAnonymousResumeByRef(
  rawRef: string
): Promise<ResumableRefTarget | null> {
  const ref = normalizeSessionRef(rawRef);
  if (!ref) return null;

  const row = await prisma.appQuestionnaireSession.findUnique({
    where: { publicRef: ref },
    select: {
      id: true,
      publicRef: true,
      status: true,
      isPreview: true,
      respondentUserId: true,
      invitationId: true,
      versionId: true,
      version: { select: { config: { select: { sessionResumeEnabled: true } } } },
    },
  });
  if (!row || !row.publicRef) return null;

  // Walk-up anonymous, non-preview, in-progress only. An invite-bound session resumes via its
  // private link, not this circulating support code.
  if (row.respondentUserId !== null) return null;
  if (row.invitationId !== null) return null;
  if (row.isPreview) return null;
  if (!(RESUMABLE_STATUSES as readonly string[]).includes(row.status)) return null;

  // The version must have resume turned on (config is 1:1 and lazy — an absent row means the
  // default, which is ON). Only an explicit `false` opts this questionnaire out.
  if (row.version.config && !row.version.config.sessionResumeEnabled) return null;

  return {
    sessionId: row.id,
    versionId: row.versionId,
    ref: row.publicRef,
    status: narrowToEnum(row.status, SESSION_STATUSES, 'active'),
  };
}
