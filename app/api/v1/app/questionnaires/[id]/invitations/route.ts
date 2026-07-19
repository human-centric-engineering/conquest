/**
 * Questionnaire invitations collection endpoint (F3.2).
 *
 * GET  /api/v1/app/questionnaires/:id/invitations
 *   Admin-only list of every invitation for the questionnaire (across its launched
 *   versions), newest-first, paginated, optionally filtered by status. Read model:
 *   `_lib/read.ts`. Never returns token material.
 *
 * POST /api/v1/app/questionnaires/:id/invitations
 *   Invite one or more respondents (single = a one-element batch). Resolves the
 *   questionnaire's launched version (409 if none), then per recipient: app-layer
 *   dedup against a live invite, mint a token, create the row, send the email. A
 *   send failure keeps the row at `pending` (resend later) — it does not fail the
 *   request. Returns a per-recipient result array.
 *
 * Both: flag-gate first (404 when off), then `withAdminAuth`. The POST adds the
 * `inviteLimiter` sub-cap (email-bombing guard) on top of the section limiter.
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { validateRequestBody, parsePaginationParams } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { inviteLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

import { recordQuestionnaireError } from '@/lib/app/questionnaire/diagnostics';
import {
  APP_INVITATION_STATUSES,
  createInvitationsSchema,
  type AppInvitationStatus,
  type InvitationSendResult,
} from '@/lib/app/questionnaire/invitations';
import { mintInvitationToken } from '@/lib/app/questionnaire/invitations/token';
import {
  parseInviteeFields,
  validateInviteeProfile,
} from '@/lib/app/questionnaire/invitations/invitee-fields';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { listInvitations } from '@/app/api/v1/app/questionnaires/[id]/invitations/_lib/read';
import {
  findLiveInvitation,
  resolveDemoClientTheme,
  resolveLaunchedVersion,
  sendInvitationEmail,
} from '@/app/api/v1/app/questionnaires/[id]/invitations/_lib/send';

const isInvitationStatus = (v: string): v is AppInvitationStatus =>
  (APP_INVITATION_STATUSES as readonly string[]).includes(v);

const handleList = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const url = new URL(request.url);
  const { page, limit } = parsePaginationParams(url.searchParams);
  const statusParam = url.searchParams.get('status');
  const status = statusParam && isInvitationStatus(statusParam) ? statusParam : undefined;

  const { invitations, total } = await listInvitations(id, { status, page, limit });
  log.info('Invitations listed', { questionnaireId: id, count: invitations.length, total });
  return successResponse(invitations, { page, limit, total });
});

const handleCreate = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const clientIp = getClientIP(request);
  const { id } = await params;

  // Email-bombing sub-cap on top of the admin section limiter.
  const rateLimit = inviteLimiter.check(clientIp);
  if (!rateLimit.success) {
    log.warn('Invitation send rate limit exceeded', {
      questionnaireId: id,
      adminId: session.user.id,
    });
    return createRateLimitResponse(rateLimit);
  }

  const body = await validateRequestBody(request, createInvitationsSchema);

  // Invitations target the launched version — refuse if the questionnaire has none.
  const target = await resolveLaunchedVersion(id);
  if (!target) {
    return errorResponse('Questionnaire has no launched version to invite respondents to', {
      code: 'INVITE_NO_LAUNCHED_VERSION',
      status: 409,
    });
  }

  // DEMO-ONLY (F3.4): resolve the brand theme once for the whole batch — every
  // recipient on this questionnaire shares its attributed demo client.
  const theme = await resolveDemoClientTheme(target.demoClientId);

  // The version's configurable invitee fields drive per-recipient validation (email is forced
  // shown+required by parseInviteeFields). Lazy config → defaults.
  const cfg = await prisma.appQuestionnaireConfig.findUnique({
    where: { versionId: target.versionId },
    select: { inviteeFields: true },
  });
  const inviteeFields = parseInviteeFields(cfg?.inviteeFields);

  const results: InvitationSendResult[] = [];
  for (const recipient of body.recipients) {
    // Validate the recipient's details against the version's invitee-field config (required
    // fields present, email valid). A failure is a per-recipient outcome, not a batch abort.
    const validation = validateInviteeProfile(inviteeFields, {
      ...(recipient.profile ?? {}),
      email: recipient.email,
    });
    if (!validation.ok) {
      results.push({ email: recipient.email, outcome: 'failed', reason: validation.message });
      continue;
    }
    // Derive a display name from first/last when not given explicitly (prefills registration).
    const derivedName =
      recipient.name ??
      ([validation.values.firstName, validation.values.surname].filter(Boolean).join(' ') || null);
    // Store the captured detail fields (sans email — it has its own column) as the profile JSON.
    const { email: _email, ...profileRest } = validation.values;
    const profileJson = Object.keys(profileRest).length > 0 ? profileRest : null;

    // App-layer dedup — a live invite to this address on this version is a no-op.
    const existing = await findLiveInvitation(target.versionId, recipient.email);
    if (existing) {
      results.push({
        email: recipient.email,
        outcome: 'skipped',
        invitationId: existing.id,
        reason: 'A live invitation already exists for this email on the launched version',
      });
      continue;
    }

    const { token, tokenHash, expiresAt } = mintInvitationToken();
    const created = await prisma.appQuestionnaireInvitation.create({
      data: {
        versionId: target.versionId,
        email: recipient.email,
        name: derivedName,
        profile: profileJson === null ? undefined : jsonInput(profileJson),
        tokenHash,
        status: 'pending',
        invitedByUserId: session.user.id,
        // DEMO-ONLY (F3.4): snapshot the attributed client onto the invitation.
        demoClientId: target.demoClientId,
        expiresAt,
      },
      select: { id: true },
    });

    // `.catch` so an email transport that THROWS (e.g. email not configured in prod)
    // degrades to a per-recipient `failed` result instead of aborting the whole batch
    // with a 500 — the admin still gets the full per-recipient outcome.
    const emailResult = await sendInvitationEmail({
      to: recipient.email,
      inviteeName: derivedName,
      questionnaireTitle: target.questionnaireTitle,
      token,
      expiresAt,
      theme,
    }).catch(() => ({ success: false, status: 'failed' as const, error: 'Email send threw' }));

    if (emailResult.success) {
      await prisma.appQuestionnaireInvitation.update({
        where: { id: created.id },
        data: { status: 'sent', sentAt: new Date() },
      });
      results.push({ email: recipient.email, outcome: 'sent', invitationId: created.id });
    } else {
      // Row kept at `pending` so the admin can resend; the request still succeeds.
      results.push({
        email: recipient.email,
        outcome: 'failed',
        invitationId: created.id,
        reason: emailResult.error ?? 'Email failed to send',
      });
      // Diagnostics: a failed invitation delivery is the canonical "why didn't this invitee ever
      // start?" signal. Record it against the version + invitation so it surfaces on the Diagnostics
      // tab. The recipient email is mild PII but is the invitation's own column (not respondent
      // conversation content), and is the key fact for debugging delivery — so it's stored in metadata.
      void recordQuestionnaireError({
        versionId: target.versionId,
        invitationId: created.id,
        scope: 'invitation_send',
        stage: 'email',
        severity: 'warning',
        error: emailResult.error ?? 'Email failed to send',
        metadata: { email: recipient.email },
      });
    }
  }

  logAdminAction({
    userId: session.user.id,
    action: 'questionnaire_invitation.create',
    entityType: 'questionnaire_version',
    entityId: target.versionId,
    metadata: {
      questionnaireId: id,
      requested: body.recipients.length,
      sent: results.filter((r) => r.outcome === 'sent').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
    },
    clientIp,
  });
  log.info('Invitations processed', { questionnaireId: id, versionId: target.versionId });

  return successResponse({ results }, undefined, { status: 201 });
});

export const GET = handleList;

export const POST = handleCreate;
