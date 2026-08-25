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
 *
 *   `conditionalTopics`, if present in the raw body, is validated and merged separately
 *   through the same read-narrow-merge-write helper the Topics tab's settings PATCH
 *   uses (`patchConditionalTopicsSettings`) rather than through `updateConfigSchema` —
 *   that schema deliberately has no `conditionalTopics` field (the topics route owns its
 *   shape and merge semantics), so a blind pass-through here would either be rejected
 *   or silently strip the key. This is what lets a full settings-export round-trip
 *   (Settings tab "Import settings", which PATCHes this endpoint with every exported
 *   key including `conditionalTopics`) restore Conditional Topics instead of silently
 *   dropping it. Both writes share the one fork decision above, so an import into a
 *   launched version forks exactly once.
 */

import { z } from 'zod';

import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { prisma } from '@/lib/db/client';
import { computeChanges, logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { updateConfigSchema } from '@/lib/app/questionnaire/authoring';
import { conditionalTopicsSettingsSchema } from '@/lib/app/questionnaire/scope/schemas';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { CONFIG_SELECT, toConfigView } from '@/app/api/v1/app/questionnaires/_lib/detail';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { patchConditionalTopicsSettings } from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
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

    // The request body is read exactly once (a body stream can only be consumed once) and
    // validated against two schemas: `updateConfigSchema` for the scalar/JSON config fields, and
    // `conditionalTopicsSettingsSchema` for `conditionalTopics` — which `updateConfigSchema` deliberately
    // has no field for (see the module docblock).
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new ValidationError('Invalid JSON in request body');
    }
    const rawConditionalTopics =
      rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>).conditionalTopics
        : undefined;

    let conditionalTopicsPatch: z.infer<typeof conditionalTopicsSettingsSchema> | undefined;
    let body: z.infer<typeof updateConfigSchema>;
    try {
      if (rawConditionalTopics !== undefined) {
        conditionalTopicsPatch = conditionalTopicsSettingsSchema.parse(rawConditionalTopics);
      }
      body = updateConfigSchema.parse(rawBody);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError('Invalid request body', {
          errors: error.issues.map((err) => ({ path: err.path.join('.'), message: err.message })),
        });
      }
      throw error;
    }

    // Fork-if-launched preamble: all writes target the editable (possibly new) id.
    // The fork copies any existing config row into the draft; the upsert below then
    // edits that copy (or creates a fresh one on the no-config path).
    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    // Read the pre-edit row BEFORE the conditionalTopics patch (below) can create/touch it — otherwise
    // a first-ever save that includes `conditionalTopics` would read back the row IT just created,
    // misreporting `created` as false and silently excluding the conditionalTopics change from the
    // audit diff (both sides would already carry the same patched value).
    const before = await prisma.appQuestionnaireConfig.findUnique({
      where: { versionId: editId },
      select: CONFIG_SELECT,
    });

    if (conditionalTopicsPatch !== undefined) {
      const settings = await patchConditionalTopicsSettings(editId, conditionalTopicsPatch);
      logAdminAction({
        userId: session.user.id,
        action: 'questionnaire_conditional_topics.update',
        entityType: 'questionnaire_version',
        entityId: editId,
        metadata: { questionnaireId: id, versionId: editId, enabled: settings.enabled },
        clientIp,
      });
    }

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
      milestoneBannerThresholds,
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
      ...(milestoneBannerThresholds !== undefined
        ? { milestoneBannerThresholds: jsonInput(milestoneBannerThresholds) }
        : {}),
    };

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
