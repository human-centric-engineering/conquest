/**
 * Topics collection — Adaptive Scope (P17).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/topics
 *   Admin-only: the version's topics, its resolved `adaptiveScope` settings, the coherence
 *   findings, and the key inventory the editor needs to offer membership pickers.
 *
 * PUT /api/v1/app/questionnaires/:id/versions/:vid/topics
 *   Admin-only: replace the topic set with the reviewed one. Forks a new draft first if the
 *   target is launched (editable id returned in `meta`), matching every other authoring route.
 *
 * PATCH /api/v1/app/questionnaires/:id/versions/:vid/topics
 *   Admin-only: patch the `adaptiveScope` settings blob — the master switch, the limit, the
 *   fallback, the hard rules. Same fork discipline.
 *
 * Rate limiting is inherited from the `/api/v1/**` section cap in `proxy.ts` — nothing here is
 * expensive enough to need a per-flow sub-cap.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { prisma } from '@/lib/db/client';

import {
  adaptiveScopeSettingsSchema,
  saveTopicsSchema,
} from '@/lib/app/questionnaire/scope/schemas';
import { validateAdaptiveScope } from '@/lib/app/questionnaire/scope/validate';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  loadAdaptiveScopeSettings,
  loadTopics,
  patchAdaptiveScopeSettings,
  replaceTopics,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';

/** The version's question + data-slot keys, for the membership pickers and the orphan check. */
async function loadKeyInventory(versionId: string) {
  const [questions, dataSlots] = await Promise.all([
    prisma.appQuestionSlot.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      select: { key: true, prompt: true, section: { select: { title: true, ordinal: true } } },
    }),
    prisma.appDataSlot.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      select: { key: true, name: true, theme: true },
    }),
  ]);
  return {
    questions: questions.map((q) => ({
      key: q.key,
      prompt: q.prompt,
      sectionTitle: q.section.title,
    })),
    dataSlots: dataSlots.map((d) => ({ key: d.key, name: d.name, theme: d.theme })),
  };
}

const handleList = withAdminAuth<{ id: string; vid: string }>(
  async (_request, _session, { params }) => {
    const { id, vid } = await params;
    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const [topics, settings, inventory] = await Promise.all([
      loadTopics(vid),
      loadAdaptiveScopeSettings(vid),
      loadKeyInventory(vid),
    ]);

    const issues = validateAdaptiveScope({
      topics,
      settings,
      allQuestionKeys: inventory.questions.map((q) => q.key),
      allDataSlotKeys: inventory.dataSlots.map((d) => d.key),
    });

    return successResponse({ topics, settings, issues, inventory });
  }
);

const handleSave = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const body = await validateRequestBody(request, saveTopicsSchema);

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    const topics = await replaceTopics(editId, body.topics);

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_topics.save',
      entityType: 'questionnaire_version',
      entityId: editId,
      metadata: { questionnaireId: id, versionId: editId, topicCount: topics.length },
      clientIp,
    });
    log.info('Adaptive scope topics saved', { versionId: editId, topicCount: topics.length });

    return successResponse({ topics }, forkMeta(fork));
  }
);

const handlePatchSettings = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const body = await validateRequestBody(request, adaptiveScopeSettingsSchema);

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    const settings = await patchAdaptiveScopeSettings(editId, body);

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_adaptive_scope.update',
      entityType: 'questionnaire_version',
      entityId: editId,
      // `enabled` is the field worth being able to grep the audit log for: it is the one that
      // changes what respondents are asked.
      metadata: { questionnaireId: id, versionId: editId, enabled: settings.enabled },
      clientIp,
    });
    log.info('Adaptive scope settings updated', { versionId: editId, enabled: settings.enabled });

    return successResponse({ settings }, forkMeta(fork));
  }
);

export const GET = handleList;
export const PUT = handleSave;
export const PATCH = handlePatchSettings;
