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
import type { Prisma } from '@prisma/client';
import { hashInvitationToken } from '@/lib/app/questionnaire/invitations';
import { findResumableSession } from '@/lib/app/questionnaire/chat/resumable-session';
import { recordSessionCreated } from '@/app/api/v1/app/questionnaires/_lib/sessions';
import {
  parseProfileFields,
  validateProfileValues,
  type ProfileValues,
} from '@/lib/app/questionnaire/profile/profile-values';

/** A created-or-resumed session, or a typed failure the route maps to an HTTP status. */
export type CreateSessionResult =
  | {
      ok: true;
      session: { id: string; status: string; versionId: string };
      /** True when an existing non-terminal session was returned (no new row minted). */
      resumed: boolean;
    }
  | { ok: false; status: number; code: string; message: string };

/**
 * Validate a respondent's profile submission against a version's configured fields,
 * for the NON-anonymous capture seam. Anonymous mode short-circuits to "nothing to
 * capture" — anonymous sessions never collect profile data (the F8.3 invariant).
 *
 * The server is the enforcing boundary, not the form: an OMITTED `profileValues` is
 * validated as an empty submission, so a version with a required field rejects with a
 * 400 even when a direct API caller sends no values (the form always submits them).
 * Versions with no fields, or only optional fields the caller omitted, capture nothing.
 * Returns the values to persist (or null), or a typed 400 to reject.
 */
function resolveProfileCapture(
  anonymous: boolean,
  profileFieldsJson: unknown,
  rawValues: Record<string, unknown> | undefined
):
  | { ok: true; values: ProfileValues | null }
  | { ok: false; status: number; code: string; message: string } {
  if (anonymous) return { ok: true, values: null };
  const fields = parseProfileFields(profileFieldsJson);
  if (fields.length === 0) return { ok: true, values: null };
  const result = validateProfileValues(fields, rawValues ?? {});
  if (!result.ok) {
    return { ok: false, status: 400, code: 'INVALID_PROFILE', message: result.message };
  }
  return { ok: true, values: Object.keys(result.values).length > 0 ? result.values : null };
}

/** Persist a profile snapshot inside the session-create transaction (non-anonymous only). */
async function writeProfileSnapshot(
  tx: Prisma.TransactionClient,
  sessionId: string,
  respondentUserId: string | null,
  values: ProfileValues
): Promise<void> {
  await tx.appRespondentProfileSnapshot.create({
    data: { sessionId, respondentUserId, values },
  });
}

/**
 * Create (or resume) a real session from a respondent's invitation token. The token's
 * invitation must belong to the authenticated user and be past accept (`registered`, or
 * `started` for re-entry).
 */
export async function createSessionFromInvitation(
  token: string,
  respondentUserId: string,
  profileValues?: Record<string, unknown>
): Promise<CreateSessionResult> {
  const invitation = await prisma.appQuestionnaireInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: {
      id: true,
      userId: true,
      status: true,
      versionId: true,
      version: {
        select: {
          status: true,
          config: { select: { anonymousMode: true, profileFields: true } },
        },
      },
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

  // Validate any profile submission against the version's fields before any write — an
  // invitation surface is never anonymous, so its profile fields (if any) are collected.
  const anonymous = invitation.version.config?.anonymousMode ?? false;
  const capture = resolveProfileCapture(
    anonymous,
    invitation.version.config?.profileFields,
    profileValues
  );
  if (!capture.ok) return capture;

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
    // Profile snapshot is captured once, on first start (skipped on resume above).
    if (capture.values)
      await writeProfileSnapshot(tx, created.id, respondentUserId, capture.values);
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
  // invitation-gated questionnaire requires the invitation path. Because this surface is
  // anonymous by definition, NO profile snapshot is ever captured here (F8.3 invariant) —
  // only the invitation path (always non-anonymous) collects profile data.
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
 * Create an admin **preview** session for a launched version — the "Preview as respondent"
 * walkthrough. Unlike {@link createAnonymousSession} it does NOT require `anonymousMode`: an
 * admin may preview any launched questionnaire, invitation-gated or not. The session is
 * marked `isPreview: true` so it is excluded from analytics (the `isPreview: false` filter in
 * `lib/app/questionnaire/analytics/**`), exactly like the F4.4/F4.5 design-time preview. It's
 * left user-less (`respondentUserId: null`) and access is proven by the signed token the
 * route mints — so the token-based turn path (`turn-access.ts`) drives it identically to the
 * no-login surface, regardless of anonymous mode. No resume: each preview mints a FRESH
 * session — and because a partial unique index allows only one preview session per version
 * (`idx_app_questionnaire_session_preview_per_version`), it first replaces any prior preview
 * (whose turns/answers/events cascade away) so re-previewing never collides. The calling
 * route is admin-gated; this seam itself trusts the caller.
 */
export async function createPreviewSession(versionId: string): Promise<CreateSessionResult> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { id: true, status: true },
  });

  // Preview mirrors the live respondent surface, which only serves launched versions.
  if (!version || version.status !== 'launched') {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Questionnaire not found' };
  }

  const session = await prisma.$transaction(async (tx) => {
    // One preview session per version (partial unique index). "Preview as respondent" is a
    // fresh walkthrough each time, so drop any prior preview (its turns / answers / events
    // cascade) before minting a new one — otherwise the insert hits a P2002 on a re-preview.
    await tx.appQuestionnaireSession.deleteMany({ where: { versionId, isPreview: true } });
    const created = await tx.appQuestionnaireSession.create({
      data: { versionId, respondentUserId: null, isPreview: true, status: 'active' },
      select: { id: true, status: true, versionId: true },
    });
    await recordSessionCreated(created.id, { tx, reason: 'admin_preview' });
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
