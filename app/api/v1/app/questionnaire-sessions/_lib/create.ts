/**
 * Session-creation seam for the live respondent surface (F6.1, PR3).
 *
 * The first writer of **real** respondent sessions (the F4.4 preview singleton aside). Two
 * authenticated entry paths, both binding `respondentUserId` and writing the reserved
 * `created` event:
 *
 *  - **Invitation-bound** — resolve the respondent's invitation (it was bound to their
 *    account at accept time), derive its `versionId`, create the session, and advance the
 *    invitation `registered → started`.
 *  - **Anonymous-direct** — for a launched questionnaire whose config has
 *    `anonymousMode = true` (the "anyone may answer" surface), create a session straight
 *    from the `versionId`. The respondent is still authenticated here (scenario "logged-in
 *    anonymous"); the admin-side identity redaction is a later phase. The no-login variant
 *    is PR5.
 *
 * Both paths are **idempotent on re-entry**: an existing non-terminal (active/paused) real
 * session for this user+version is returned instead of minting a second one.
 */

import { prisma } from '@/lib/db/client';
import { hashInvitationToken } from '@/lib/app/questionnaire/invitations';
import { recordSessionCreated } from '@/app/api/v1/app/questionnaires/_lib/sessions';

/** A created-or-resumed session, or a typed failure the route maps to an HTTP status. */
export type CreateSessionResult =
  | {
      ok: true;
      session: { id: string; status: string; versionId: string };
      /** True when an existing non-terminal session was returned (no new row minted). */
      resumed: boolean;
    }
  | { ok: false; status: number; code: string; message: string };

/** Find a respondent's existing non-terminal real session for a version (resume target). */
async function findResumableSession(
  versionId: string,
  respondentUserId: string
): Promise<{ id: string; status: string; versionId: string } | null> {
  const row = await prisma.appQuestionnaireSession.findFirst({
    where: {
      versionId,
      respondentUserId,
      isPreview: false,
      status: { in: ['active', 'paused'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, versionId: true },
  });
  return row;
}

/**
 * Create (or resume) a real session from a respondent's invitation token. The token's
 * invitation must belong to the authenticated user and be past accept (`registered`, or
 * `started` for re-entry).
 */
export async function createSessionFromInvitation(
  token: string,
  respondentUserId: string
): Promise<CreateSessionResult> {
  const invitation = await prisma.appQuestionnaireInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: {
      id: true,
      userId: true,
      status: true,
      versionId: true,
      version: { select: { status: true } },
    },
  });

  if (!invitation) {
    return {
      ok: false,
      status: 404,
      code: 'INVITATION_NOT_FOUND',
      message: 'Invitation not found',
    };
  }
  // The invitation must be bound to the calling user (accept binds userId). Don't reveal
  // whether the token exists for someone else — a generic 403.
  if (invitation.userId !== respondentUserId) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: 'This invitation is not yours' };
  }
  if (invitation.status !== 'registered' && invitation.status !== 'started') {
    return {
      ok: false,
      status: 409,
      code: 'INVITATION_NOT_STARTABLE',
      message: `An invitation in "${invitation.status}" cannot start a session`,
    };
  }
  if (invitation.version.status !== 'launched') {
    return {
      ok: false,
      status: 409,
      code: 'VERSION_NOT_LAUNCHED',
      message: 'This questionnaire is not currently open',
    };
  }

  const existing = await findResumableSession(invitation.versionId, respondentUserId);
  if (existing) return { ok: true, session: existing, resumed: true };

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.appQuestionnaireSession.create({
      data: {
        versionId: invitation.versionId,
        respondentUserId,
        isPreview: false,
        status: 'active',
      },
      select: { id: true, status: true, versionId: true },
    });
    await recordSessionCreated(created.id, { tx });
    // Advance the invitation lifecycle on first start; a re-entry (already `started`) is a no-op.
    if (invitation.status === 'registered') {
      await tx.appQuestionnaireInvitation.update({
        where: { id: invitation.id },
        data: { status: 'started' },
      });
    }
    return created;
  });

  return { ok: true, session, resumed: false };
}

/**
 * Create (or resume) a real session straight from a `versionId` for an authenticated
 * respondent. Allowed only for a launched version whose config has `anonymousMode = true`
 * (the open, no-invitation surface). The respondent is bound as `respondentUserId`.
 */
export async function createSessionForVersion(
  versionId: string,
  respondentUserId: string
): Promise<CreateSessionResult> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { id: true, status: true, config: { select: { anonymousMode: true } } },
  });

  // A non-existent or unlaunched version is a 404 — don't reveal draft/archived versions.
  if (!version || version.status !== 'launched') {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Questionnaire not found' };
  }
  // Direct (no-invitation) starts are only for the anonymous-mode surface; an
  // invitation-gated questionnaire requires the invitation path.
  if (!version.config?.anonymousMode) {
    return {
      ok: false,
      status: 403,
      code: 'INVITATION_REQUIRED',
      message: 'This questionnaire requires an invitation',
    };
  }

  const existing = await findResumableSession(versionId, respondentUserId);
  if (existing) return { ok: true, session: existing, resumed: true };

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.appQuestionnaireSession.create({
      data: { versionId, respondentUserId, isPreview: false, status: 'active' },
      select: { id: true, status: true, versionId: true },
    });
    await recordSessionCreated(created.id, { tx });
    return created;
  });

  return { ok: true, session, resumed: false };
}

/**
 * Create a NO-LOGIN anonymous session for a launched `anonymousMode` version — the public
 * pop-up/demo surface (F6.1, PR6). Unlike the authenticated paths, `respondentUserId` is
 * left null; access is later proven by the signed token the route mints. No resume here:
 * an anonymous caller can't be re-identified across requests without the token, so each
 * create mints a fresh session.
 */
export async function createAnonymousSession(versionId: string): Promise<CreateSessionResult> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { id: true, status: true, config: { select: { anonymousMode: true } } },
  });

  if (!version || version.status !== 'launched') {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Questionnaire not found' };
  }
  if (!version.config?.anonymousMode) {
    return {
      ok: false,
      status: 403,
      code: 'INVITATION_REQUIRED',
      message: 'This questionnaire requires an invitation',
    };
  }

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.appQuestionnaireSession.create({
      data: { versionId, respondentUserId: null, isPreview: false, status: 'active' },
      select: { id: true, status: true, versionId: true },
    });
    await recordSessionCreated(created.id, { tx });
    return created;
  });

  return { ok: true, session, resumed: false };
}
