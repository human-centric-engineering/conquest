/**
 * Glossary collection — definitions / glossary feature (P16).
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/glossary
 *   Admin-only: the version's curated terms (every status, so the review queue can show what was
 *   proposed and what was rejected) plus any attached authoritative definitions document.
 *
 * PUT /api/v1/app/questionnaires/:id/versions/:vid/glossary
 *   Admin-only: replace the version's glossary with the reviewed set. Forks a new draft first if
 *   the target is launched (editable id returned in `meta`).
 *
 * No per-flow rate-limit sub-cap: neither handler makes a paid call, so both sit under the
 * inherited /api/v1 section cap. The paid surface is the analysis stream, which caps itself.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { saveGlossarySchema } from '@/lib/app/questionnaire/glossary';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  deleteProposedGlossaryTerms,
  loadGlossaryDocument,
  loadGlossaryTerms,
  replaceGlossaryTerms,
} from '@/app/api/v1/app/questionnaires/_lib/glossary-routes';

const handleList = withAdminAuth<{ id: string; vid: string }>(
  async (_request, _session, { params }) => {
    const { id, vid } = await params;
    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }
    const [terms, document] = await Promise.all([
      loadGlossaryTerms(vid),
      loadGlossaryDocument(vid),
    ]);
    return successResponse({ terms, document });
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

    const body = await validateRequestBody(request, saveGlossarySchema);

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    const terms = await replaceGlossaryTerms(editId, body.terms, session.user.id);
    // The reviewed set replaces the edited version's terms outright. If the save forked off a
    // launched version, the analyst's proposals left behind on the SOURCE version are now
    // orphaned adjudications no one will ever act on — retire them.
    if (editId !== vid) {
      await deleteProposedGlossaryTerms(vid);
    }

    const acceptedCount = terms.filter((term) => term.status === 'accepted').length;

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_glossary.save',
      entityType: 'questionnaire_version',
      entityId: editId,
      metadata: {
        questionnaireId: id,
        versionId: editId,
        termCount: terms.length,
        acceptedCount,
      },
      clientIp,
    });
    log.info('Glossary saved', { versionId: editId, termCount: terms.length, acceptedCount });

    return successResponse({ terms }, forkMeta(fork));
  }
);

export const GET = handleList;
export const PUT = handleSave;
