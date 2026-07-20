/**
 * Resolve `/x/<publicRef>` to the leg the respondent should be looking at (P15.3).
 *
 * The stable-address surface: one URL for a whole journey, resolving server-side to whichever leg
 * the run is currently on. `AppExperienceRun.publicRef` was reserved for exactly this from the
 * start ("doubles as the respondent-facing URL segment so a stitched journey keeps one address
 * across its legs").
 *
 * ## The access rule
 *
 * `publicRef` ADDRESSES; it never AUTHORISES. It is an eight-character human-quotable support code
 * — guessable in a way a credential must never be. Two things can authorise:
 *
 *  - the httpOnly run cookie, for the no-login surface, or
 *  - owning one of the run's sessions, for an authenticated respondent.
 *
 * Both are checked against the run resolved FROM the ref, so a valid cookie for run A presented at
 * run B's address fails. There is no admin bypass: an admin viewing a respondent's conversation
 * has its own audited surface, and this is not it.
 */

import { prisma } from '@/lib/db/client';
import { getServerSession } from '@/lib/auth/utils';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import {
  EXPERIENCE_RUN_STATUSES,
  type ExperienceRunStatus,
} from '@/lib/app/questionnaire/experiences/run/types';
import { verifyRunToken } from '@/app/api/v1/app/experiences/_lib/run-access-token';
import { mintSessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';

/** Why a run surface could not be opened. Drives which notice the page renders. */
export type RunSurfaceDenial =
  /** No run carries this ref — a mistyped or stale link. */
  | 'not_found'
  /**
   * The run exists but this browser cannot prove it owns it. Almost always a genuine respondent on
   * a DIFFERENT device or after clearing cookies — the credential is deliberately not in the URL,
   * so it cannot travel with a copied link. Rendered as an explanation, not an error.
   */
  | 'no_credential';

export type RunSurface =
  | {
      ok: true;
      runId: string;
      publicRef: string;
      status: ExperienceRunStatus;
      /** The leg to open — the newest, which is where the journey actually is. */
      sessionId: string;
      versionId: string;
      /**
       * A minted token for that leg, for the no-login surface only.
       *
       * The workspace still drives its per-turn API calls with a session token even though the
       * journey is authorised by the cookie. Minted fresh on every page load rather than stored,
       * so it is never older than the request that produced it. Null for an authenticated
       * respondent, whose own cookie already opens the session.
       */
      sessionToken: string | null;
    }
  | { ok: false; reason: RunSurfaceDenial };

/**
 * Resolve the run surface for a public ref, given the request's cookies.
 *
 * `cookieValues` is every `cq_run_*` cookie on the request. They are scanned rather than looked up
 * by name because the cookie NAME is untrusted input: only the signed payload decides which run a
 * credential is for, so a cookie called `cq_run_ANYTHING` carrying a token for a different run
 * fails the id comparison below.
 */
export async function resolveRunSurface(
  publicRef: string,
  cookieValues: string[]
): Promise<RunSurface> {
  const run = await prisma.appExperienceRun.findUnique({
    where: { publicRef },
    select: {
      id: true,
      publicRef: true,
      status: true,
      legs: {
        orderBy: { ordinal: 'desc' },
        take: 1,
        select: { sessionId: true },
      },
    },
  });
  // Same answer for "no such run" as for a run with no legs: both are dead addresses, and
  // distinguishing them would confirm a ref exists to someone guessing.
  if (!run || run.legs.length === 0 || !run.publicRef) return { ok: false, reason: 'not_found' };

  const sessionId = run.legs[0].sessionId;

  // The session is an unmodelled pointer (UG-1), so it can dangle. A run whose newest leg's
  // session has been erased is not openable — treat it as a dead address rather than throwing.
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: { id: true, versionId: true, respondentUserId: true },
  });
  if (!session) return { ok: false, reason: 'not_found' };

  const status = narrowToEnum(run.status, EXPERIENCE_RUN_STATUSES, 'active');

  // No-login path: a run credential that verifies to THIS run.
  const hasRunCookie = cookieValues.some((value) => {
    const verified = verifyRunToken(value, new Date());
    return verified.ok && verified.runId === run.id;
  });
  if (hasRunCookie) {
    return {
      ok: true,
      runId: run.id,
      publicRef: run.publicRef,
      status,
      sessionId: session.id,
      versionId: session.versionId,
      sessionToken: mintSessionToken(session.id).token,
    };
  }

  // Authenticated path: the respondent owns this leg. Supported so that a signed-in respondent who
  // follows an `/x/` link is not dead-ended on a surface their account can plainly open.
  const auth = await getServerSession();
  if (auth?.user && session.respondentUserId === auth.user.id) {
    return {
      ok: true,
      runId: run.id,
      publicRef: run.publicRef,
      status,
      sessionId: session.id,
      versionId: session.versionId,
      sessionToken: null,
    };
  }

  return { ok: false, reason: 'no_credential' };
}
