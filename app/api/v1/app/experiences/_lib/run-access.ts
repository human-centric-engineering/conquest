/**
 * Who may read an experience run — the shared respondent-facing access check (P15.3).
 *
 * Extracted from the status route when the stitched-transcript route needed exactly the same rule.
 * Two routes enforcing "prove you are inside this run" independently is precisely the shape that
 * drifts: one gets a fix the other doesn't, and the weaker of the two becomes the way in. The
 * transcript route is the more sensitive of the pair — it returns whole conversations, not a
 * one-word state — so it must never be the one running the laxer check.
 *
 * Ownership is proven against the run's LEGS, not the run row: the no-login surface holds a token
 * for a session and the authenticated surface owns sessions, so neither knows a run id directly.
 */

import type { NextRequest } from 'next/server';

import { prisma } from '@/lib/db/client';
import { getServerSession } from '@/lib/auth/utils';
import { verifySessionToken } from '@/app/api/v1/app/questionnaire-sessions/_lib/session-access-token';
import { verifyRunToken } from '@/app/api/v1/app/experiences/_lib/run-access-token';

/** Cookie-name prefix for run credentials; see `runCookieName`. */
const RUN_COOKIE_PREFIX = 'cq_run_';

/**
 * Whether the request carries a valid run credential for THIS run.
 *
 * Scans every `cq_run_*` cookie rather than resolving the run's `publicRef` first and looking up
 * one name. That trades a database read for a handful of cheap HMAC verifications, and it means a
 * respondent holding credentials for several concurrent journeys is handled with no special case:
 * the one that verifies to this `runId` wins, the rest simply do not match.
 *
 * The cookie NAME is untrusted input and is never parsed for meaning — only the signed payload
 * decides which run the credential is for. A cookie called `cq_run_ANYTHING` carrying a token
 * minted for a different run fails the `runId` comparison.
 */
function readRunCookie(request: NextRequest, runId: string): boolean {
  for (const cookie of request.cookies.getAll()) {
    if (!cookie.name.startsWith(RUN_COOKIE_PREFIX)) continue;
    const verified = verifyRunToken(cookie.value, new Date());
    if (verified.ok && verified.runId === runId) return true;
  }
  return false;
}

export interface RunAccess {
  allowed: boolean;
  /** The leg the caller proved ownership of, when the proof identified one. */
  knownSessionId?: string;
  /**
   * True when the proof was a signed session token — i.e. the no-login surface.
   *
   * The status route uses this to decide whether to mint a token for a newly-revealed leg. An
   * admin reading someone else's run must never be handed a respondent credential, so this is
   * false for both the admin bypass and the cookie-authenticated respondent.
   */
  viaToken?: boolean;
  /**
   * True when access came from the run credential (the `/x/<publicRef>` surface).
   *
   * Like `viaToken` this earns a minted session token for a newly-revealed leg: the holder is on
   * the no-login surface and the workspace still drives its per-turn API calls with a session
   * token, even though the journey itself is authorised by the cookie.
   */
  viaRunCookie?: boolean;
  /** True when access came from the admin bypass rather than from owning a leg. */
  isAdmin?: boolean;
}

/** Whether this caller may read this run. */
export async function canReadRun(request: NextRequest, runId: string): Promise<RunAccess> {
  const legs = await prisma.appExperienceRunLeg.findMany({
    where: { runId },
    orderBy: { ordinal: 'desc' },
    select: { sessionId: true },
  });
  const legSessionIds = new Set(legs.map((l) => l.sessionId));

  // The run credential (P15.3) — an httpOnly cookie covering every leg, checked FIRST because it
  // is the strongest proof available on the no-login surface and the one the `/x/<publicRef>`
  // surface carries. `knownSessionId` resolves to the NEWEST leg: a run-scoped credential says
  // nothing about which leg the holder is on, and the newest is the only defensible reading —
  // it is where the journey actually is.
  //
  // Checked BEFORE the "no legs" refusal below, because a legless run is a normal state on the
  // meeting path: a participant is present from the moment they join and does not get a leg until
  // the facilitator starts a breakout. The credential is HMAC-bound to this exact `runId`, so
  // whether legs exist yet has no bearing on whether its holder belongs inside the run. There is
  // simply no leg to name, hence no `knownSessionId`.
  const runCookie = readRunCookie(request, runId);
  if (runCookie) {
    return {
      allowed: true,
      ...(legs.length > 0 ? { knownSessionId: legs[0].sessionId } : {}),
      viaRunCookie: true,
    };
  }

  // Every remaining proof is made against a leg, so a legless run cannot satisfy any of them.
  if (legs.length === 0) return { allowed: false };

  // No-login surface, legacy per-session path: a signed token for any session in this run.
  const token = request.headers.get('x-session-token');
  if (token) {
    const verified = verifySessionToken(token, new Date());
    if (verified.ok && legSessionIds.has(verified.sessionId)) {
      return { allowed: true, knownSessionId: verified.sessionId, viaToken: true };
    }
  }

  const session = await getServerSession();
  if (!session?.user) return { allowed: false };
  if (session.user.role === 'ADMIN') return { allowed: true, isAdmin: true };

  // Authenticated respondent: they must own at least one of the run's sessions.
  const owned = await prisma.appQuestionnaireSession.findFirst({
    where: { id: { in: [...legSessionIds] }, respondentUserId: session.user.id },
    select: { id: true },
  });
  return owned ? { allowed: true, knownSessionId: owned.id } : { allowed: false };
}
