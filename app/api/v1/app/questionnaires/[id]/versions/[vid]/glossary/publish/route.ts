/**
 * Publish a version's glossary to the demo client's knowledge base (P16) — OPT-IN, ONE-WAY.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/glossary/publish
 *   Admin-only. Renders the accepted terms as a markdown document and files it under the demo
 *   client's private knowledge tag, so client-scoped agents can retrieve it.
 *
 * ## Read this before changing anything here
 *
 * The report writer ALREADY receives this glossary directly from the database, correctly
 * version-scoped, with no retrieval step (see `report/generate.ts`). This endpoint therefore buys
 * exactly one thing: reach into OTHER client-scoped agents. That is a smaller prize than it looks,
 * and it is bought at a real cost:
 *
 *  - **Scope mismatch.** The knowledge base is scoped per `AppDemoClient`; a glossary is per
 *    version. A client with two questionnaires that define "ego" differently ends up with two
 *    contradictory documents in one corpus, both retrievable for either questionnaire, with the
 *    consumer silently picking one. The rendered document leads with a scope line for exactly this
 *    reason, and the document NAME carries the questionnaire + version so the two are at least
 *    visibly distinct in the KB panel.
 *  - **No unpublish.** `uploadDocument` dedupes on content hash and returns the existing row; it
 *    never retires an older document. Publishing v3 and then v4 leaves both live. Removing one is
 *    a manual step in the knowledge-base admin.
 *  - **It escapes the version boundary.** Every other write in this feature forks and stays
 *    contained. This one does not, and cannot be forked back.
 *
 * Hence: never automatic, never on save, always an explicit admin action behind a dialog that
 * names the client and states the blast radius.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { prisma } from '@/lib/db/client';
import { uploadDocument } from '@/lib/orchestration/knowledge/document-manager';
import { ensureClientKnowledgeTag } from '@/lib/app/questionnaire/report/client-knowledge';
import { buildGlossaryAppendix } from '@/lib/app/questionnaire/glossary/report-appendix';
import { loadAcceptedGlossaryEntries } from '@/lib/app/questionnaire/glossary/resolve';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  loadGlossaryPublishTarget,
  renderGlossaryKnowledgeDocument,
} from '@/app/api/v1/app/questionnaires/_lib/glossary-routes';

const handlePublish = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    // Reuse the ingestion sub-cap: a publish chunks and embeds a document, the same paid class.
    const rl = ingestLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Glossary publish rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const target = await loadGlossaryPublishTarget(id, vid);
    if (!target) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    // An unattributed questionnaire has no client corpus to publish into. A clear 409 beats a
    // silent no-op the admin would read as success.
    if (!target.demoClientId) {
      return errorResponse(
        'Attribute this questionnaire to a client before publishing its glossary — the knowledge base is scoped per client.',
        { code: 'NO_CLIENT_ATTRIBUTED', status: 409 }
      );
    }

    const appendix = buildGlossaryAppendix(await loadAcceptedGlossaryEntries(vid));
    if (!appendix) {
      return errorResponse('There are no accepted terms to publish yet.', {
        code: 'EMPTY_GLOSSARY',
        status: 409,
      });
    }

    const tagId = await ensureClientKnowledgeTag(target.demoClientId);
    if (!tagId) {
      return errorResponse('Could not resolve the client knowledge base.', {
        code: 'CLIENT_KB_UNAVAILABLE',
        status: 409,
      });
    }

    // Deterministic name + slug so two questionnaires' glossaries are visibly distinct in the KB
    // panel rather than silently indistinguishable.
    const displayName = `Glossary — ${target.questionnaireTitle} (v${target.versionNumber})`;
    const content = renderGlossaryKnowledgeDocument(target, appendix.entries);
    // Traceable back to the exact version it came from — the only provenance a KB reader gets.
    const sourceUrl = `/admin/questionnaires/${id}/v/${vid}/definitions`;

    const document = await uploadDocument(
      content,
      `${displayName}.md`,
      adminId,
      sourceUrl,
      displayName
    );

    // Apply the client's tag — this is what scopes the document to their corpus. Idempotent, so a
    // re-publish of identical content (which `uploadDocument` dedupes to the existing row) does not
    // fail on the unique constraint.
    await prisma.aiKnowledgeDocumentTag.upsert({
      where: { documentId_tagId: { documentId: document.id, tagId } },
      create: { documentId: document.id, tagId },
      update: {},
    });

    logAdminAction({
      userId: adminId,
      action: 'questionnaire_glossary.publish_to_client_kb',
      entityType: 'questionnaire_version',
      entityId: vid,
      metadata: {
        questionnaireId: id,
        versionId: vid,
        demoClientId: target.demoClientId,
        documentId: document.id,
        termCount: appendix.entries.length,
      },
      clientIp,
    });
    log.info('Glossary published to client knowledge base', {
      versionId: vid,
      demoClientId: target.demoClientId,
      documentId: document.id,
      termCount: appendix.entries.length,
    });

    return successResponse({
      documentId: document.id,
      documentName: displayName,
      termCount: appendix.entries.length,
      clientName: target.demoClientName,
    });
  }
);

export const POST = handlePublish;
