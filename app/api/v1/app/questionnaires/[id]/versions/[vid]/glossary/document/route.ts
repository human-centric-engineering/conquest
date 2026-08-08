/**
 * Authoritative definitions document — definitions / glossary (P16).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/glossary/document  (multipart: `file`)
 *   Admin-only. Parses an uploaded document (.pdf / .docx / .md / .txt) to plain text and attaches
 *   it to the version as the AUTHORITATIVE source the Glossary Analyst prefers over anything it
 *   infers. One per version — a second upload replaces the first.
 *
 * DELETE /api/v1/app/questionnaires/:id/versions/:vid/glossary/document
 *   Admin-only. Detaches the document. Terms already drawn from it are kept.
 *
 * The text is stored, never embedded or chunked: it is analysis input, not knowledge-base
 * material. (The knowledge base is scoped per demo client while a glossary is scoped per version,
 * so an automatic mirror would let two questionnaires' contradictory definitions of the same term
 * collide in one corpus.)
 *
 * Both handlers fork a launched version — unlike the analysis run, attaching or removing the
 * source of truth is a durable authoring change.
 */

import { createHash } from 'node:crypto';

import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';

import { forkVersionIfLaunched } from '@/app/api/v1/app/questionnaires/_lib/fork';
import { forkMeta, loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { parseUploadGuard } from '@/app/api/v1/app/questionnaires/intro-background/_lib/input';
import {
  deleteGlossaryDocument,
  upsertGlossaryDocument,
} from '@/app/api/v1/app/questionnaires/_lib/glossary-routes';

/**
 * Cap on the stored text. The whole document is fed to the analyst in one prompt, so an unbounded
 * upload would blow the context window and fail the run rather than degrade it. 200k characters is
 * far beyond any real glossary while staying well inside a reasoning model's window.
 */
const GLOSSARY_DOCUMENT_MAX_CHARS = 200_000;

const handleUpload = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    // Reuse the ingestion sub-cap — a document parse is the same class of expensive admin upload.
    const rl = ingestLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Glossary document upload rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const guard = await parseUploadGuard(request);
    if (!guard.ok) return guard.response;
    const { file } = guard;

    let buffer: Buffer;
    let fullText: string;
    try {
      buffer = Buffer.from(await file.arrayBuffer());
      const parsed = await parseDocument(buffer, file.name);
      fullText = parsed.fullText;
    } catch (err) {
      log.warn('Glossary document parse failed', {
        adminId,
        fileName: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse('Could not read that document', { code: 'PARSE_FAILED', status: 422 });
    }

    const trimmed = fullText.trim();
    if (trimmed.length === 0) {
      // A scanned PDF is the common cause — worth saying so rather than storing an empty source
      // the analyst would silently treat as "no document".
      return errorResponse(
        'No text could be extracted from that document. If it is a scan, it needs OCR first.',
        { code: 'EMPTY_DOCUMENT', status: 422 }
      );
    }

    const extractedText = trimmed.slice(0, GLOSSARY_DOCUMENT_MAX_CHARS);
    const truncated = trimmed.length > extractedText.length;

    const fork = await forkVersionIfLaunched(scoped, { userId: adminId, clientIp });
    const editId = fork.versionId;

    const document = await upsertGlossaryDocument(
      editId,
      {
        fileName: file.name,
        fileHash: createHash('sha256').update(buffer).digest('hex'),
        byteSize: file.size,
        mimeType: file.type || null,
        extractedText,
      },
      adminId
    );

    logAdminAction({
      userId: adminId,
      action: 'questionnaire_glossary_document.upload',
      entityType: 'questionnaire_version',
      entityId: editId,
      metadata: {
        questionnaireId: id,
        versionId: editId,
        fileName: file.name,
        byteSize: file.size,
        chars: extractedText.length,
        truncated,
      },
      clientIp,
    });
    log.info('Glossary definitions document attached', {
      versionId: editId,
      fileName: file.name,
      chars: extractedText.length,
      truncated,
    });

    return successResponse({ document, truncated }, forkMeta(fork));
  }
);

const handleDelete = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;

    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    const fork = await forkVersionIfLaunched(scoped, { userId: session.user.id, clientIp });
    const editId = fork.versionId;

    await deleteGlossaryDocument(editId);

    logAdminAction({
      userId: session.user.id,
      action: 'questionnaire_glossary_document.remove',
      entityType: 'questionnaire_version',
      entityId: editId,
      metadata: { questionnaireId: id, versionId: editId },
      clientIp,
    });
    log.info('Glossary definitions document removed', { versionId: editId });

    return successResponse({ ok: true }, forkMeta(fork));
  }
);

export const POST = handleUpload;
export const DELETE = handleDelete;
