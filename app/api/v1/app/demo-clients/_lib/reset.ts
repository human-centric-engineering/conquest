/**
 * DEMO-ONLY (F6.4): demo session-reset DB seam.
 *
 * The between-demos "clean slate" — hard-deletes the session graph (and, opt-in,
 * stale invitations) for every version of every questionnaire attributed to a demo
 * client. Route-local because `lib/app/questionnaire/**` is Prisma-free; the
 * `[id]/reset-sessions` route composes the guards (flag, admin auth, anonymousMode
 * refusal, typed confirmation) around these two functions.
 *
 * A real client engagement strips this surface — see
 * .context/app/questionnaire/forking.md § "Replacing demo tenancy".
 */

import { prisma } from '@/lib/db/client';
import { RESET_PRESERVED_INVITATION_STATUSES } from '@/lib/app/questionnaire/invitations/types';

/** The per-type row counts a reset deleted — echoed to the caller and audit-logged. */
export interface ResetDeletedCounts {
  sessions: number;
  answerSlots: number;
  turns: number;
  events: number;
  invitations: number;
}

/** What `loadResetTargets` resolves before the route opens the delete transaction. */
export interface ResetTargets {
  /** Every version id under this client's questionnaires (empty = nothing to reset). */
  versionIds: string[];
  /** True when any of those versions runs in anonymous mode (the 409-refusal signal). */
  anyAnonymous: boolean;
}

/**
 * Collect the reset targets for a demo client in one query: every version under its
 * questionnaires plus each version's `anonymousMode`. Config is 1:1 and lazy — an
 * absent row means the default (`anonymousMode = false`). A client with no
 * questionnaires resolves to `{ versionIds: [], anyAnonymous: false }`.
 */
export async function loadResetTargets(demoClientId: string): Promise<ResetTargets> {
  const versions = await prisma.appQuestionnaireVersion.findMany({
    where: { questionnaire: { demoClientId } },
    select: { id: true, config: { select: { anonymousMode: true } } },
  });

  return {
    versionIds: versions.map((v) => v.id),
    anyAnonymous: versions.some((v) => v.config?.anonymousMode === true),
  };
}

/**
 * Hard-delete the session graph for the given versions in one transaction. Children
 * are deleted before their parent session so each `deleteMany().count` is accurate —
 * the `onDelete: Cascade` FKs would otherwise zero the child counts before we read
 * them. Preview sessions are included by design: a clean slate clears admin preview
 * exercises too. When `resetInvitations` is set, stale invitations
 * (`pending | sent | opened | registered`) are also deleted; real progress
 * (`started | completed`) and admin revocations (`revoked`) are preserved.
 *
 * Empty `versionIds` short-circuits to all-zero counts without opening a transaction.
 */
export async function performReset(
  versionIds: string[],
  opts: { resetInvitations: boolean }
): Promise<ResetDeletedCounts> {
  if (versionIds.length === 0) {
    return { sessions: 0, answerSlots: 0, turns: 0, events: 0, invitations: 0 };
  }

  const sessionScope = { session: { versionId: { in: versionIds } } };

  return prisma.$transaction(async (tx) => {
    const answerSlots = await tx.appAnswerSlot.deleteMany({ where: sessionScope });
    const turns = await tx.appQuestionnaireTurn.deleteMany({ where: sessionScope });
    const events = await tx.appQuestionnaireSessionEvent.deleteMany({ where: sessionScope });
    const sessions = await tx.appQuestionnaireSession.deleteMany({
      where: { versionId: { in: versionIds } },
    });

    let invitations = 0;
    if (opts.resetInvitations) {
      const del = await tx.appQuestionnaireInvitation.deleteMany({
        where: {
          versionId: { in: versionIds },
          status: { notIn: [...RESET_PRESERVED_INVITATION_STATUSES] },
        },
      });
      invitations = del.count;
    }

    return {
      sessions: sessions.count,
      answerSlots: answerSlots.count,
      turns: turns.count,
      events: events.count,
      invitations,
    };
  });
}
