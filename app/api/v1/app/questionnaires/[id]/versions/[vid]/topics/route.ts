/**
 * Topics collection — Conditional Topics (P17).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/topics
 *   Admin-only: the version's topics, its resolved `conditionalTopics` settings, the coherence
 *   findings, the key inventory the editor needs to offer membership pickers, and the Routing
 *   Analyst's pending proposal when one is waiting for review (`draft`, else null). Also carries
 *   the ingestion-time candidacy verdict and whether the analyst should now auto-run from it
 *   (`candidacy` / `autoTriggerPending`, F17.19 Phase 3).
 *
 * PUT /api/v1/app/questionnaires/:id/versions/:vid/topics
 *   Admin-only: replace the topic set with the reviewed one. Forks a new draft first if the
 *   target is launched (editable id returned in `meta`), matching every other authoring route.
 *
 * PATCH /api/v1/app/questionnaires/:id/versions/:vid/topics
 *   Admin-only: patch the `conditionalTopics` settings blob — the master switch, the limit, the
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
  alwaysTopicSeconds,
  estimateTopicCosts,
  itemSeconds,
  matrixRowCount,
  routedAllowanceSeconds,
} from '@/lib/app/questionnaire/scope/budget';
import type { ConditionalTopicsSettings } from '@/lib/app/questionnaire/scope/types';

import {
  conditionalTopicsSettingsSchema,
  saveTopicsSchema,
} from '@/lib/app/questionnaire/scope/schemas';
import {
  uncoveredDataSlotKeys,
  uncoveredQuestionKeys,
  validateConditionalTopics,
} from '@/lib/app/questionnaire/scope/validate';
import { loadScoringSchemaContent } from '@/lib/app/questionnaire/scoring/compute';
import { buildPlanPreviewForm } from '@/lib/app/questionnaire/scope/views';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  loadConditionalTopicsSettings,
  loadMaxDataSlotAttempts,
  loadTopics,
  patchConditionalTopicsSettings,
  replaceTopics,
} from '@/app/api/v1/app/questionnaires/_lib/topic-routes';
import { loadTopicDraft } from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import { listSourceDocuments } from '@/app/api/v1/app/questionnaires/_lib/source-documents';
import {
  loadCachedCandidacyVerdict,
  resolveAutoTriggerPending,
} from '@/app/api/v1/app/questionnaires/_lib/scope-candidacy';

/**
 * The version's question + data-slot keys, for the membership pickers and the orphan check — plus
 * everything the time arithmetic needs (C7): each question's `type` and, for a matrix, how many
 * rows it asks the respondent to rate. `weight` rides along because a `light` topic asks its
 * highest-weight members, so the cost of one depends on it.
 */
async function loadKeyInventory(versionId: string, settings: ConditionalTopicsSettings) {
  const [questions, dataSlots] = await Promise.all([
    prisma.appQuestionSlot.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      select: {
        key: true,
        prompt: true,
        type: true,
        typeConfig: true,
        weight: true,
        section: { select: { title: true, ordinal: true } },
      },
    }),
    prisma.appDataSlot.findMany({
      where: { versionId },
      orderBy: { ordinal: 'asc' },
      // `description` is loaded for the uncoverable-member check (F17.36) and deliberately NOT
      // returned in the payload below: the pickers show a name, and shipping every slot's full
      // description to the browser would grow the response for nothing.
      select: { key: true, name: true, description: true, theme: true, weight: true },
    }),
  ]);

  const seconds = itemSeconds(
    questions.map((q) => ({ key: q.key, type: q.type, rowCount: matrixRowCount(q.typeConfig) })),
    dataSlots.map((d) => d.key),
    settings
  );

  return {
    questions: questions.map((q) => ({
      key: q.key,
      prompt: q.prompt,
      sectionTitle: q.section.title,
      type: q.type,
      estimatedSeconds: seconds.byQuestionKey.get(q.key) ?? 0,
      weight: q.weight,
    })),
    dataSlots: dataSlots.map((d) => ({
      key: d.key,
      name: d.name,
      theme: d.theme,
      estimatedSeconds: seconds.byDataSlotKey.get(d.key) ?? 0,
      weight: d.weight,
    })),
    seconds,
    weights: {
      byQuestionKey: new Map(questions.map((q) => [q.key, q.weight] as const)),
      byDataSlotKey: new Map(dataSlots.map((d) => [d.key, d.weight] as const)),
    },
    // F17.36 — the wording the uncoverable-member check reads. A data slot's name and description
    // together, because either alone can be the half that gives it away: a slot named "routing"
    // described neutrally, or one named neutrally whose description says the interviewer fills it.
    memberText: {
      byQuestionKey: Object.fromEntries(questions.map((q) => [q.key, q.prompt] as const)),
      byDataSlotKey: Object.fromEntries(
        dataSlots.map((d) => [d.key, `${d.name}. ${d.description}`] as const)
      ),
    },
  };
}

const handleList = withAdminAuth<{ id: string; vid: string }>(
  async (_request, _session, { params }) => {
    const { id, vid } = await params;
    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    // Settings first: the key inventory prices itself against this version's per-type overrides.
    const settings = await loadConditionalTopicsSettings(vid);
    const [topics, inventory, draft, scoring, maxDataSlotAttempts, candidacy, documents] =
      await Promise.all([
        loadTopics(vid),
        loadKeyInventory(vid, settings),
        loadTopicDraft(vid),
        // For the comparability checks (F17.15) — which scales routing can leave partially assessed.
        // `null` for the versions that do not score, which is most of them.
        loadScoringSchemaContent(vid),
        // For the opening follow-up checks (G03) — the per-slot re-ask cap the allowance sits under.
        loadMaxDataSlotAttempts(vid),
        // F17.19 Phase 3: the ingestion-time candidacy verdict — independent of everything else
        // above, so it rides this same batch rather than paying a second serial round-trip.
        loadCachedCandidacyVerdict(vid),
        // F17.29: the documents the analyst will read. Metadata only — the card above the topic list
        // names them, and a second fetch for at most six filenames is a round-trip for nothing.
        listSourceDocuments(vid),
      ]);

    // The time arithmetic (C7), computed here for the same reason `issues` is: one implementation,
    // so the number an author reads and the number the planner works to cannot disagree.
    const byTopicKey = estimateTopicCosts(topics, inventory.seconds, inventory.weights);
    const alwaysSeconds = alwaysTopicSeconds(topics, byTopicKey);
    const conditionalCosts = topics
      .filter((t) => t.phase === 'conditional')
      .map((t) => byTopicKey.get(t.key)?.full ?? 0)
      .filter((s) => s > 0);

    const allQuestionKeys = inventory.questions.map((q) => q.key);
    const allDataSlotKeys = inventory.dataSlots.map((d) => d.key);

    const issues = validateConditionalTopics({
      topics,
      settings,
      allQuestionKeys,
      allDataSlotKeys,
      seconds: {
        always: alwaysSeconds,
        cheapestConditional: conditionalCosts.length > 0 ? Math.min(...conditionalCosts) : 0,
        byTopicKey: Object.fromEntries([...byTopicKey].map(([key, cost]) => [key, cost.full])),
      },
      scoring: scoring ?? undefined,
      // G03: the per-slot re-ask cap, so the tab can say when an opening follow-up limit cannot
      // bind. It lives on the Settings tab, which is why the author cannot see it from here.
      maxDataSlotAttempts,
      // F17.36: so the check can tell an opening question from a scripted handoff line.
      memberText: inventory.memberText,
    });
    const costs = {
      budgetSeconds: settings.sessionBudgetSeconds,
      alwaysSeconds,
      routedAllowanceSeconds: routedAllowanceSeconds(settings.sessionBudgetSeconds, alwaysSeconds),
      byTopicKey: Object.fromEntries(byTopicKey),
    };

    // F17.19 Phase 3: whether the Routing Analyst should fire on its own right now, because Phase
    // 1 flagged this document at ingestion and nothing has acted on it since.
    const autoTriggerPending = await resolveAutoTriggerPending(vid, candidacy, {
      hasAuthoredTopic: topics.some((t) => t.source !== 'seeded'),
      hasDraft: draft !== null,
      enabled: settings.enabled,
    });

    return successResponse({
      topics,
      settings,
      issues,
      inventory: { questions: inventory.questions, dataSlots: inventory.dataSlots },
      costs,
      draft,
      preview: buildPlanPreviewForm(
        topics,
        inventory.dataSlots,
        new Map(inventory.questions.map((q) => [q.key, q.prompt] as const))
      ),
      candidacy,
      autoTriggerPending,
      // Through the SAME helpers the orphan findings above use, so a header reporting "3 questions
      // in no topic" and an issue list reporting a different number is not a state this payload
      // can be in.
      coverage: {
        totalQuestions: allQuestionKeys.length,
        uncoveredQuestions: uncoveredQuestionKeys(topics, allQuestionKeys).length,
        totalDataSlots: allDataSlotKeys.length,
        uncoveredDataSlots: uncoveredDataSlotKeys(topics, allDataSlotKeys).length,
      },
      documents,
    });
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
    log.info('Conditional topics topics saved', { versionId: editId, topicCount: topics.length });

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

    const body = await validateRequestBody(request, conditionalTopicsSettingsSchema);

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    const settings = await patchConditionalTopicsSettings(editId, body);

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_conditional_topics.update',
      entityType: 'questionnaire_version',
      entityId: editId,
      // `enabled` is the field worth being able to grep the audit log for: it is the one that
      // changes what respondents are asked.
      metadata: { questionnaireId: id, versionId: editId, enabled: settings.enabled },
      clientIp,
    });
    log.info('Conditional topics settings updated', {
      versionId: editId,
      enabled: settings.enabled,
    });

    return successResponse({ settings }, forkMeta(fork));
  }
);

export const GET = handleList;
export const PUT = handleSave;
export const PATCH = handlePatchSettings;
