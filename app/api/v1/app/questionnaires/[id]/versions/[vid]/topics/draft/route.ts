/**
 * The Routing Analyst's pending proposal — Adaptive Scope (P17.4).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/topics/draft
 *   Admin-only: ACCEPT the reviewed proposal. Writes the topics live (stamped `analyst`), replaces
 *   the hard rules, optionally applies the breadth limit the document stated, optionally turns
 *   adaptive scope on when the admin asked for it (`enable`), and clears the draft — in one
 *   transaction. Forks a new draft first if the target is launched.
 *
 * DELETE /api/v1/app/questionnaires/:id/versions/:vid/topics/draft
 *   Admin-only: discard the pending proposal. The live topic set is untouched. Idempotent —
 *   discarding when there is no draft is a no-op success.
 *
 * **The discard does NOT fork a launched version, and the accept does.** A proposal is inert:
 * nothing but the review surface reads `AppQuestionnaireTopicDraft`, so deleting one changes
 * nothing a respondent or the runtime can see. Accepting it changes what gets asked. That is the
 * same split the glossary's analyse-vs-save routes draw.
 *
 * Rate limiting is inherited from the `/api/v1/**` section cap in `proxy.ts`.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { acceptTopicDraftSchema } from '@/lib/app/questionnaire/scope/schemas';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  acceptTopicDraft,
  discardTopicDraft,
} from '@/app/api/v1/app/questionnaires/_lib/topic-draft';

const handleAccept = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const body = await validateRequestBody(request, acceptTopicDraftSchema);

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    const result = await acceptTopicDraft(editId, body);

    // `copyVersionGraph` deliberately does not carry the draft into a fork, so the accept above
    // cleared a draft the fork never had — while the SOURCE version still holds the proposal the
    // admin has just acted on. Clear it there too, or that version keeps a review queue for work
    // already done and re-accepting it would write the same topics twice.
    if (fork.forked) await discardTopicDraft(vid);

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_topics.accept_draft',
      entityType: 'questionnaire_version',
      entityId: editId,
      metadata: {
        questionnaireId: id,
        versionId: editId,
        topicCount: result.topics.length,
        ruleCount: result.settings.rules.length,
        // Audited because this accept may be the moment adaptive scope went live for respondents —
        // a change in what gets asked, not just in what is authored.
        scopeEnabled: result.settings.enabled,
        enabledByAccept: body.enable === true,
      },
      clientIp,
    });
    log.info('Routing proposal accepted', {
      versionId: editId,
      topicCount: result.topics.length,
      ruleCount: result.settings.rules.length,
      enabledByAccept: body.enable === true,
    });

    return successResponse(result, forkMeta(fork));
  }
);

const handleDiscard = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    await discardTopicDraft(vid);

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_topics.discard_draft',
      entityType: 'questionnaire_version',
      entityId: vid,
      metadata: { questionnaireId: id, versionId: vid },
      clientIp,
    });
    log.info('Routing proposal discarded', { versionId: vid });

    return successResponse({ discarded: true });
  }
);

export const POST = handleAccept;
export const DELETE = handleDiscard;
