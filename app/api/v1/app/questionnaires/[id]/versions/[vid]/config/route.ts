/**
 * Questionnaire version configuration endpoint (F3.1).
 *
 * PATCH /api/v1/app/questionnaires/:id/versions/:vid/config
 *   Admin-only edit of a version's run-time configuration — selection strategy,
 *   completion thresholds, budget/caps, voice/contradiction/anonymous modes, and
 *   the session-start profile fields. Partial: any subset of fields; an omitted
 *   key leaves the stored (or default) value unchanged.
 *
 *   Lazy materialization — the config row is created on first save (upsert). The
 *   read side serves `DEFAULT_QUESTIONNAIRE_CONFIG` until then, so there is no
 *   separate GET: the version graph (`…/versions/:vid`) already carries `config`.
 *
 *   Forks a new draft first if the target is launched (the editable id comes back
 *   in `meta`); the fork preamble copies any existing config into the draft, and
 *   this upsert then writes to the draft's row.
 */

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { updateConfigSchema } from '@/lib/app/questionnaire/authoring';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { CONFIG_SELECT, toConfigView } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';

const handleConfigPatch = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      throw new NotFoundError('Questionnaire version not found');
    }

    const body = await validateRequestBody(request, updateConfigSchema);

    // Fork-if-launched preamble: all writes target the editable (possibly new) id.
    // The fork copies any existing config row into the draft; the upsert below then
    // edits that copy (or creates a fresh one on the no-config path).
    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    // Build the write payload from the provided keys only (partial save). `accessMode` is a scalar
    // (flows through `scalars`); `profileFields`, `inviteeFields`, `tone`, and `respondentReport`
    // are JSON columns, wrapped below.
    const {
      profileFields,
      inviteeFields,
      tone,
      personaSelection,
      respondentReport,
      cohortReport,
      intro,
      ...scalars
    } = body;
    const writeData = {
      ...scalars,
      ...(profileFields !== undefined ? { profileFields: jsonInput(profileFields) } : {}),
      ...(inviteeFields !== undefined ? { inviteeFields: jsonInput(inviteeFields) } : {}),
      ...(tone !== undefined ? { tone: jsonInput(tone) } : {}),
      ...(personaSelection !== undefined ? { personaSelection: jsonInput(personaSelection) } : {}),
      ...(respondentReport !== undefined ? { respondentReport: jsonInput(respondentReport) } : {}),
      ...(cohortReport !== undefined ? { cohortReport: jsonInput(cohortReport) } : {}),
      ...(intro !== undefined ? { intro: jsonInput(intro) } : {}),
    };

    // Read the pre-edit row for the audit diff (null on first save).
    const before = await prisma.appQuestionnaireConfig.findUnique({
      where: { versionId: editId },
      select: CONFIG_SELECT,
    });

    const updated = await prisma.appQuestionnaireConfig.upsert({
      where: { versionId: editId },
      create: { versionId: editId, ...writeData },
      update: writeData,
      select: CONFIG_SELECT,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_config.update',
      entityType: 'questionnaire_config',
      entityId: editId,
      changes: computeChanges(before ?? {}, updated),
      clientIp,
    });
    log.info('Questionnaire version config updated', {
      questionnaireId: id,
      versionId: editId,
      forked: fork.forked,
      created: before === null,
    });

    return successResponse(toConfigView(updated), forkMeta(fork));
  }
);

export const PATCH = handleConfigPatch;
