/**
 * Respondent chat-banner header — runtime resolution (DB seam).
 *
 * Loads the {@link BandHeader} the brand band renders: the questionnaire title, plus — for a
 * session bound to a time-bound round — that round's name and open/close window. Two entry
 * points mirror the two respondent surfaces:
 *
 *  - {@link resolveSessionHeader} — the authenticated `/questionnaires/[sessionId]` surface, which
 *    has a session and therefore its `roundId`. Because `roundId` is a plain String (no Prisma
 *    `@relation`; UG-1 identity-firewall posture), the round is fetched in a SECOND query.
 *  - {@link resolveVersionHeader} — the no-login `/q/[versionId]` surface, where the session is
 *    booted client-side and does not exist at SSR; only the version's title is resolvable, so the
 *    round is always null (the band shows the title, omits the schedule cluster).
 *
 * Server-only (reads Prisma). The `./schedule` derivation and `./types` contract stay pure.
 */

import { cache } from 'react';

import { prisma } from '@/lib/db/client';
import type { BandHeader } from '@/lib/app/questionnaire/header/types';

/**
 * Resolve the banner header for an existing session. Returns null when the session id doesn't
 * resolve (caller maps that to "no band content"). A session with no `roundId` is open-ended:
 * `round` is null and the band shows just the title.
 *
 * `cache()`-wrapped: the run pages resolve the header in BOTH `generateMetadata` and the page body,
 * and React dedupes same-arg calls within one request so the query runs once.
 */
export const resolveSessionHeader = cache(async (sessionId: string): Promise<BandHeader | null> => {
  const session = await prisma.appQuestionnaireSession.findUnique({
    where: { id: sessionId },
    select: {
      roundId: true,
      version: { select: { questionnaire: { select: { title: true } } } },
    },
  });
  if (!session) return null;

  const title = session.version.questionnaire.title;
  if (!session.roundId) return { title, round: null };

  // Second query: roundId is a plain String, not a @relation, so it can't be joined above.
  const round = await prisma.appQuestionnaireRound.findUnique({
    where: { id: session.roundId },
    select: { name: true, status: true, opensAt: true, closesAt: true, closedAt: true },
  });

  return {
    title,
    round: round
      ? {
          name: round.name,
          status: round.status,
          opensAt: round.opensAt,
          closesAt: round.closesAt,
          closedAt: round.closedAt,
        }
      : null,
  };
});

/**
 * Resolve the banner header for a version (no-login surface, pre-session). Only the title is
 * available — there is no session yet, so no round. Returns null when the version doesn't resolve.
 *
 * `cache()`-wrapped for the same reason as {@link resolveSessionHeader}: the public run page resolves
 * it in both `generateMetadata` and the page body.
 */
export const resolveVersionHeader = cache(async (versionId: string): Promise<BandHeader | null> => {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { questionnaire: { select: { title: true } } },
  });
  if (!version) return null;
  return { title: version.questionnaire.title, round: null };
});

/**
 * Resolve a session's questionnaire title **only when it belongs to `userId`** — for the
 * authenticated run page's `generateMetadata`, which must not leak another user's questionnaire title
 * into `<title>` (the page body 404s for non-owners without confirming existence; metadata must match
 * that posture). Returns null when the session is missing OR owned by someone else. `cache()`-wrapped.
 */
export const resolveOwnedSessionTitle = cache(
  async (sessionId: string, userId: string): Promise<string | null> => {
    const session = await prisma.appQuestionnaireSession.findUnique({
      where: { id: sessionId },
      select: {
        respondentUserId: true,
        version: { select: { questionnaire: { select: { title: true } } } },
      },
    });
    if (!session || session.respondentUserId !== userId) return null;
    return session.version.questionnaire.title;
  }
);
