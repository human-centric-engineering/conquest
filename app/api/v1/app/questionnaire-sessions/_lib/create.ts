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
import { generateSessionRef } from '@/lib/app/questionnaire/session-ref';
import { hashInvitationToken } from '@/lib/app/questionnaire/invitations';
import { isInvitationTransitionAllowed } from '@/lib/app/questionnaire/invitations/status';
import { narrowToEnum } from '@/lib/app/questionnaire/types';
import {
  APP_INVITATION_STATUSES,
  type AppInvitationStatus,
} from '@/lib/app/questionnaire/invitations/types';
import {
  findResumableSession,
  findResumableSessionByInvitation,
} from '@/lib/app/questionnaire/chat/resumable-session';
import {
  assertRoundAccess,
  resolveCohortSubgroupId,
} from '@/app/api/v1/app/questionnaire-sessions/_lib/round-access';
import { recordSessionCreated } from '@/app/api/v1/app/questionnaires/_lib/sessions';
import { loadLaunchReadiness } from '@/app/api/v1/app/questionnaires/_lib/launchability';
import {
  parseProfileFields,
  validateProfileValues,
  type ProfileValues,
} from '@/lib/app/questionnaire/profile/profile-values';

/**
 * Cohorts & Rounds: the round a session runs within, plus the cohort member it belongs to.
 * This is derived from the respondent's **invitation** (the server-trusted grant) — NOT from
 * the client request — so round membership can't be forged. Absent = an open-ended, non-time-bound
 * session (today's behaviour). When present, {@link assertRoundAccess} gates the start (window +
 * active membership) and both ids are persisted so the continue/resume paths can re-check.
 */
export interface RoundContext {
  roundId: string;
  cohortMemberId: string | null;
}

/** Lift the round context off a resolved invitation row, or undefined for a plain invitation. */
function roundContextOf(invitation: {
  roundId: string | null;
  cohortMemberId: string | null;
}): RoundContext | undefined {
  return invitation.roundId
    ? { roundId: invitation.roundId, cohortMemberId: invitation.cohortMemberId }
    : undefined;
}

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
      // Cohorts & Rounds: the SERVER-TRUSTED round context (set when this invitation was minted
      // for a round). The session inherits it from here — never from the client request.
      roundId: true,
      cohortMemberId: true,
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

  // Cohorts & Rounds: a round-bound invitation carries its round context. Gate the start
  // (window + active membership) before any write; the context comes from the trusted
  // invitation row, so it can't be forged by the caller.
  const round = roundContextOf(invitation);
  if (round) {
    const verdict = await assertRoundAccess({
      roundId: round.roundId,
      cohortMemberId: round.cohortMemberId,
      versionId: invitation.versionId,
      onMissingRound: 'deny',
    });
    if (!verdict.ok) return verdict;
  }

  const existing = await findResumableSession(
    invitation.versionId,
    respondentUserId,
    round?.roundId
  );
  if (existing) return { ok: true, session: existing, resumed: true };

  // Snapshot the member's subgroup (for per-phase stats) — null for non-round/no-subgroup sessions.
  const cohortSubgroupId = round ? await resolveCohortSubgroupId(round.cohortMemberId) : null;

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.appQuestionnaireSession.create({
      data: {
        versionId: invitation.versionId,
        respondentUserId,
        roundId: round?.roundId ?? null,
        cohortMemberId: round?.cohortMemberId ?? null,
        cohortSubgroupId,
        publicRef: generateSessionRef(),
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
 * respondent. Allowed only for a launched version whose `accessMode` permits a direct
 * (no-invitation) start — `public` or `both`. The respondent is bound as `respondentUserId`.
 *
 * Profile capture is skipped on this direct-start surface (no profile form precedes a
 * walk-up start); identity, when wanted, is collected on the invitation path. A non-anonymous
 * `public` questionnaire therefore won't collect a profile from a walk-up respondent — a
 * deliberate scoping gap (public walk-up profile capture is a follow-up).
 */
export async function createSessionForVersion(
  versionId: string,
  respondentUserId: string
): Promise<CreateSessionResult> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { id: true, status: true, config: { select: { accessMode: true } } },
  });

  // A non-existent or unlaunched version is a 404 — don't reveal draft/archived versions.
  if (!version || version.status !== 'launched') {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Questionnaire not found' };
  }
  // Direct (no-invitation) starts need an access mode that permits them; an invitation_only
  // questionnaire requires the invitation path. Unconfigured versions default to invitation_only.
  if ((version.config?.accessMode ?? 'invitation_only') === 'invitation_only') {
    return {
      ok: false,
      status: 403,
      code: 'INVITATION_REQUIRED',
      message: 'This questionnaire requires an invitation',
    };
  }

  // A walk-up (no invitation) start is never round-bound — a round delivers to known cohort
  // members via per-member invitations, so there's no round context to enforce here.
  const existing = await findResumableSession(versionId, respondentUserId);
  if (existing) return { ok: true, session: existing, resumed: true };

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.appQuestionnaireSession.create({
      data: {
        versionId,
        respondentUserId,
        publicRef: generateSessionRef(),
        isPreview: false,
        status: 'active',
      },
      select: { id: true, status: true, versionId: true },
    });
    await recordSessionCreated(created.id, { tx });
    return created;
  });

  return { ok: true, session, resumed: false };
}

/**
 * Create an admin **preview** session for the "Preview as respondent" walkthrough. Allowed for a
 * **launched** version OR a **launchable draft** (one that passes the launch readiness gate —
 * goal, audience, sections, questions, saved config, and data slots when required), so an admin
 * can rehearse the conversation before launching. Archived versions are retired and not
 * previewable. Unlike {@link createAnonymousSession} it does NOT require `anonymousMode`: an
 * admin may preview any eligible questionnaire, invitation-gated or not. The session is
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

  // Non-existent or archived (retired) versions are not previewable — 404, don't reveal them.
  if (!version || version.status === 'archived') {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Questionnaire not found' };
  }
  // A launched version is always previewable; a draft is previewable once it passes the same
  // readiness gate as launch (so an admin can rehearse it before going live). Exception: the
  // adaptive "Questions embedded" check is launch-only — preview rehearsal is allowed before
  // embedding because the live turn loop embeds slots lazily as a backstop.
  if (version.status !== 'launched') {
    const { ready } = await loadLaunchReadiness(versionId, { includeEmbeddings: false });
    if (!ready) {
      return {
        ok: false,
        status: 409,
        code: 'NOT_READY_FOR_PREVIEW',
        message: 'This version is not ready to preview yet — complete the launch checklist first.',
      };
    }
  }

  const session = await prisma.$transaction(async (tx) => {
    // One preview session per version (partial unique index). "Preview as respondent" is a
    // fresh walkthrough each time, so drop any prior preview (its turns / answers / events
    // cascade) before minting a new one — otherwise the insert hits a P2002 on a re-preview.
    await tx.appQuestionnaireSession.deleteMany({ where: { versionId, isPreview: true } });
    const created = await tx.appQuestionnaireSession.create({
      data: {
        versionId,
        respondentUserId: null,
        publicRef: generateSessionRef(),
        isPreview: true,
        status: 'active',
      },
      select: { id: true, status: true, versionId: true },
    });
    await recordSessionCreated(created.id, { tx, reason: 'admin_preview' });
    return created;
  });

  return { ok: true, session, resumed: false };
}

/**
 * Create a NO-LOGIN session for a launched version whose `accessMode` permits a public start
 * (`public` or `both`) — the public pop-up/demo surface (F6.1, PR6). Unlike the authenticated
 * paths, `respondentUserId` is left null; access is later proven by the signed token the route
 * mints. No resume here: a no-login caller can't be re-identified across requests without the
 * token, so each create mints a fresh session. (Access, not anonymity: a `public` questionnaire
 * may still be non-anonymous — but a no-login walk-up has no account to attach a profile to.)
 */
export async function createAnonymousSession(versionId: string): Promise<CreateSessionResult> {
  const version = await prisma.appQuestionnaireVersion.findUnique({
    where: { id: versionId },
    select: { id: true, status: true, config: { select: { accessMode: true } } },
  });

  if (!version || version.status !== 'launched') {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Questionnaire not found' };
  }
  if ((version.config?.accessMode ?? 'invitation_only') === 'invitation_only') {
    return {
      ok: false,
      status: 403,
      code: 'INVITATION_REQUIRED',
      message: 'This questionnaire requires an invitation',
    };
  }

  // A no-login public walk-up is never round-bound (no cohort member to bind to); rounds are
  // delivered via per-member invitations (the from-invite path inherits the round context).
  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.appQuestionnaireSession.create({
      data: {
        versionId,
        respondentUserId: null,
        publicRef: generateSessionRef(),
        isPreview: false,
        status: 'active',
      },
      select: { id: true, status: true, versionId: true },
    });
    await recordSessionCreated(created.id, { tx });
    return created;
  });

  return { ok: true, session, resumed: false };
}

/**
 * Create (or resume) a NO-LOGIN session from a per-invitee token — the frictionless invite flow
 * (Phase B). The token IS the credential: a valid, non-revoked, non-expired invitation for a
 * launched version boots a session with `respondentUserId: null` and `invitationId` set, so the
 * existing anonymous turn path (HMAC `X-Session-Token`) drives every turn unchanged. The invitee
 * never registers an account; the admin captured their details at invite time (`invitation.profile`)
 * so NO profile snapshot is written here — identity lives on the invitation, read only for status
 * (the completion-tracking-only invariant). Idempotent: a re-opened link resumes the existing
 * non-terminal session (keyed on `invitationId`). On first start the invitation advances to
 * `started`. Gated by the frictionless-invites flag at the route.
 */
export async function createSessionFromInviteToken(token: string): Promise<CreateSessionResult> {
  const invitation = await prisma.appQuestionnaireInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(token) },
    select: {
      id: true,
      status: true,
      versionId: true,
      revokedAt: true,
      expiresAt: true,
      // Cohorts & Rounds: the server-trusted round context this frictionless link carries.
      roundId: true,
      cohortMemberId: true,
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
  if (invitation.revokedAt !== null || invitation.status === 'revoked') {
    return {
      ok: false,
      status: 410,
      code: 'INVITATION_REVOKED',
      message: 'This invitation link has been revoked',
    };
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    return {
      ok: false,
      status: 410,
      code: 'INVITATION_EXPIRED',
      message: 'This invitation link has expired',
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

  // Cohorts & Rounds: a round-bound frictionless link carries its round context on the
  // invitation. Gate the start before any write — trusted source, not the caller.
  const round = roundContextOf(invitation);
  if (round) {
    const verdict = await assertRoundAccess({
      roundId: round.roundId,
      cohortMemberId: round.cohortMemberId,
      versionId: invitation.versionId,
      onMissingRound: 'deny',
    });
    if (!verdict.ok) return verdict;
  }

  // Idempotent re-entry: a previously-booted, still-open session for this invitation.
  const existing = await findResumableSessionByInvitation(invitation.id, round?.roundId);
  if (existing) return { ok: true, session: existing, resumed: true };

  // Snapshot the member's subgroup (for per-phase stats) — null for non-round/no-subgroup sessions.
  const cohortSubgroupId = round ? await resolveCohortSubgroupId(round.cohortMemberId) : null;

  const from = narrowToEnum<AppInvitationStatus>(
    invitation.status,
    APP_INVITATION_STATUSES,
    'sent'
  );
  const advance = isInvitationTransitionAllowed(from, 'started');

  const session = await prisma.$transaction(async (tx) => {
    const created = await tx.appQuestionnaireSession.create({
      data: {
        versionId: invitation.versionId,
        respondentUserId: null,
        invitationId: invitation.id,
        roundId: round?.roundId ?? null,
        cohortMemberId: round?.cohortMemberId ?? null,
        cohortSubgroupId,
        publicRef: generateSessionRef(),
        isPreview: false,
        status: 'active',
      },
      select: { id: true, status: true, versionId: true },
    });
    await recordSessionCreated(created.id, { tx });
    if (advance) {
      await tx.appQuestionnaireInvitation.update({
        where: { id: invitation.id },
        data: { status: 'started' },
      });
    }
    return created;
  });

  return { ok: true, session, resumed: false };
}
