/**
 * Questionnaire version status endpoint (F2.1 / PR2).
 *
 * PATCH /api/v1/app/questionnaires/:id/versions/:vid/status
 *   Admin-only lifecycle flip of a version's `status`. Launching makes the
 *   version-fork seam live: a subsequent content edit to a `launched` version
 *   forks a fresh draft.
 *
 * Allowed transitions:
 *   draft    → launched | archived
 *   launched → draft (un-launch) | archived
 *   archived → (terminal in PR2)
 *
 * Launch gate (F3.1): `draft → launched` requires goal + audience + at least one
 * section + at least one question + a saved configuration (a config row exists —
 * the admin's deliberate "ready" signal, since unsaved config resolves to
 * defaults). Operates on the version's status only; questionnaire-level status
 * orchestration is deferred to P3. (Pre-launch cost estimation is F3.3.)
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { ConflictError, ValidationError } from '@/lib/api/errors';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { withQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import { updateVersionStatusSchema } from '@/lib/app/questionnaire/authoring';
import {
  countLaunchBlockers,
  hasLaunchBlockers,
} from '@/app/api/v1/app/questionnaires/_lib/launch-blockers';
import { loadLaunchReadiness } from '@/app/api/v1/app/questionnaires/_lib/launchability';
import type { LaunchCheckKey } from '@/lib/app/questionnaire/launch/readiness';
import type { AppQuestionnaireStatus } from '@/lib/app/questionnaire/types';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';

/** Legal target statuses per current status (PR2 lifecycle). */
const ALLOWED_TRANSITIONS: Record<AppQuestionnaireStatus, AppQuestionnaireStatus[]> = {
  draft: ['launched', 'archived'],
  launched: ['draft', 'archived'],
  archived: [],
};

/** Per-check launch-gate error messages, keyed by the shared readiness check key. */
const LAUNCH_MISSING_MESSAGE: Record<LaunchCheckKey, string> = {
  goal: 'A goal is required to launch',
  audience: 'An audience is required to launch',
  sections: 'At least one section is required',
  questions: 'At least one question is required',
  config: 'Configuration must be saved before launch',
  scaleLabels:
    'Label every point of each rating scale before launch (or switch a purely numeric rating to the Numeric type)',
  embeddings: 'Generate question embeddings before launching the adaptive strategy',
  dataSlots: 'Generate data slots before launch',
  dataSlotEmbeddings: 'Generate data-slot embeddings before launching adaptive data-slot selection',
};

/**
 * Readiness check for `draft → launched` (F3.1): goal + audience + ≥1 section + ≥1 question + a
 * saved config row (+ data slots when the feature is on). Delegates to the shared
 * {@link loadLaunchReadiness} — the same criteria the "Preview as respondent" gate uses — and
 * maps any failed check to the launch-gate's `missing` validation detail.
 */
async function assertLaunchable(versionId: string): Promise<void> {
  const { checks } = await loadLaunchReadiness(versionId);
  const missing: Record<string, string[]> = {};
  for (const check of checks) {
    if (!check.ok) missing[check.key] = [LAUNCH_MISSING_MESSAGE[check.key]];
  }
  if (Object.keys(missing).length > 0) {
    throw new ValidationError('Version is not ready to launch', missing);
  }
}

const handleStatusPatch = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const { status: to } = await validateRequestBody(request, updateVersionStatusSchema);
    const from = scoped.status;

    if (from === to) {
      throw new ValidationError(`Version is already ${to}`, {
        status: [`Version is already ${to}`],
      });
    }
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new ValidationError(`Cannot transition a version from ${from} to ${to}`, {
        status: [`Illegal transition from ${from} to ${to}`],
      });
    }
    // Leaving `launched` (un-launch / archive) must not strand live work pinned to
    // this version. As of F3.2 `countLaunchBlockers` returns the real count of live
    // invitations (sessions join at P4) — a launched version with live invitations
    // cannot be un-launched/archived out from under them.
    if (from === 'launched' && hasLaunchBlockers(await countLaunchBlockers(vid))) {
      throw new ConflictError(
        'Cannot change status: this version has live sessions or invitations'
      );
    }
    if (to === 'launched') await assertLaunchable(vid);

    const updated = await prisma.appQuestionnaireVersion.update({
      where: { id: vid },
      data: { status: to },
      select: { id: true, versionNumber: true, status: true },
    });

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_version.status',
      entityType: 'questionnaire_version',
      entityId: vid,
      changes: computeChanges({ status: from }, { status: to }),
      clientIp,
    });
    log.info('Questionnaire version status changed', {
      questionnaireId: id,
      versionId: vid,
      from,
      to,
    });

    return successResponse(updated);
  }
);

export const PATCH = withQuestionnairesEnabled(handleStatusPatch);
