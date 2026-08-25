/**
 * A version's source documents — what it was built from, and what was attached beside it.
 *
 * GET /api/v1/app/questionnaires/:id/versions/:vid/documents
 *   Admin-only: every document on the version, newest first, with the role that says what each
 *   one IS. Metadata only — never the extracted text, which is the instrument itself and can be
 *   megabytes.
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/documents
 *   Admin-only, multipart: attach a **supplementary** document. Parsed to text and stored; the
 *   version's questions, sections and settings are not touched. Only the Routing Analyst reads it,
 *   which is the whole point — an instrument that arrived as a question bank plus a separate
 *   routing memo could previously only have one of the two on the version, because the sole way to
 *   add a second document was a re-ingest that replaces the structure extracted from the first.
 *
 * There is deliberately no way to POST a `primary` document here. That role belongs to ingest and
 * re-ingest, which extract a structure from it in the same pass; a primary row written without one
 * would claim the version's questions came from a document they did not come from.
 *
 * Rate limit: the per-admin `ingestLimiter` sub-cap, shared with ingest and re-ingest — this parses
 * an upload, so it belongs in the same budget rather than the section default.
 */

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { jsonInput } from '@/app/api/v1/app/_lib/prisma-json';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { MAX_SUPPLEMENTARY_DOCUMENTS } from '@/lib/app/questionnaire/constants';

import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import {
  parseAndGuardUpload,
  parseUploadToText,
} from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';
import { listSourceDocuments } from '@/app/api/v1/app/questionnaires/_lib/source-documents';

const handleList = withAdminAuth<{ id: string; vid: string }>(
  async (_request, _session, { params }) => {
    const { id, vid } = await params;
    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    return successResponse({ documents: await listSourceDocuments(vid) });
  }
);

const handleAttach = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const { id, vid } = await params;
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);

    // Per-admin sub-cap, shared with ingest and re-ingest — this parses an upload. The 100/min
    // `api` section cap was already applied by middleware. Synchronous, like every other caller.
    const limit = ingestLimiter.check(session.user.id);
    if (!limit.success) {
      log.warn('Supporting-document attach rate limit exceeded', {
        adminId: session.user.id,
        reset: limit.reset,
      });
      return createRateLimitResponse(limit);
    }

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const guarded = await parseAndGuardUpload(request);
    if (!guarded.ok) return guarded.response;
    const upload = guarded.value;

    // Count and dedup BEFORE parsing: both are cheap reads, and parsing a 25MB PDF only to reject
    // it for being the file the admin already attached wastes the one expensive step here.
    const [supplementaryCount, duplicate] = await Promise.all([
      prisma.appQuestionnaireSourceDocument.count({
        where: { versionId: vid, role: 'supplementary' },
      }),
      prisma.appQuestionnaireSourceDocument.findFirst({
        where: { versionId: vid, fileHash: upload.fileHash },
        select: { id: true, fileName: true, role: true },
      }),
    ]);

    if (duplicate) {
      return errorResponse(
        duplicate.role === 'primary'
          ? 'That file is the document this questionnaire was built from'
          : 'That file is already attached',
        {
          code: 'DUPLICATE_DOCUMENT',
          status: 409,
          details: { file: [`Already on this version as "${duplicate.fileName}"`] },
        }
      );
    }

    if (supplementaryCount >= MAX_SUPPLEMENTARY_DOCUMENTS) {
      return errorResponse('This version already has the maximum supporting documents', {
        code: 'TOO_MANY_DOCUMENTS',
        status: 409,
        details: {
          file: [`Remove one first — the limit is ${MAX_SUPPLEMENTARY_DOCUMENTS}`],
        },
      });
    }

    const parsed = await parseUploadToText(upload, log);
    if (!parsed.ok) return parsed.response;

    // Same discipline as every other authoring route: a launched version is never edited in place.
    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    const document = await prisma.appQuestionnaireSourceDocument.create({
      data: {
        versionId: editId,
        role: 'supplementary',
        fileName: upload.file.name,
        fileHash: upload.fileHash,
        byteSize: upload.file.size,
        ...(upload.file.type ? { mimeType: upload.file.type } : {}),
        ...(parsed.value.pageInfo ? { pageCount: parsed.value.pageInfo.length } : {}),
        warnings: parsed.value.warnings.length > 0 ? jsonInput(parsed.value.warnings) : undefined,
        extractedText: parsed.value.fullText,
      },
      select: { id: true },
    });

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_source_document.attach',
      entityType: 'questionnaire_version',
      entityId: editId,
      metadata: {
        questionnaireId: id,
        versionId: editId,
        documentId: document.id,
        fileName: upload.file.name,
        role: 'supplementary',
      },
      clientIp,
    });
    log.info('Supporting document attached', {
      versionId: editId,
      documentId: document.id,
      characters: parsed.value.fullText.length,
    });

    return successResponse({ documents: await listSourceDocuments(editId) }, forkMeta(fork), {
      status: 201,
    });
  }
);

export const GET = handleList;
export const POST = handleAttach;
