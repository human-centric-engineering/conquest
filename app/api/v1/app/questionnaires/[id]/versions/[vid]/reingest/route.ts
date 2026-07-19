/**
 * Questionnaire re-ingest endpoint (F2.4).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/reingest
 *   Multipart upload of a *replacement* source document (.pdf / .docx / .md /
 *   .txt) against an existing **draft** version. Re-runs the same opinionated
 *   extractor as a fresh ingest and **replaces that draft's extracted graph +
 *   editorial change log** with the new one. Destructive of manual edits / tag
 *   assignments on the draft — the UI confirms before calling.
 *
 * Pipeline (order is load-bearing):
 *   flag-gate → withAdminAuth → per-admin sub-cap → scope-404 → draft-only 409 →
 *   guard upload → version-scoped SHA-256 dedup short-circuit → parse + extract →
 *   transactional replace → admin audit → 200.
 *
 * Differs from a new ingest (`POST /questionnaires`) at exactly two seams: the
 * **dedup** is scoped to this version (identical bytes → 200 no-op, not a global
 * 409) and the **persist** replaces the draft graph in place instead of creating
 * a questionnaire. Everything in between is the shared `_lib/extract-pipeline.ts`.
 *
 * Re-ingest of a `launched`/`archived` version is refused (`REINGEST_NOT_DRAFT`,
 * 409) — it is a draft editorial operation, not a fork. Auth: admin only.
 * Rate limit: shares the per-admin `ingestLimiter` sub-cap with new ingest (each
 * re-ingest is ≥1 reasoning LLM call).
 */

import { errorResponse, successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import {
  extractFromDocument,
  parseAndGuardUpload,
} from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';
import {
  ReingestNotDraftError,
  reingestVersion,
} from '@/app/api/v1/app/questionnaires/_lib/reingest';

const handleReingest = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const adminId = session.user.id;
    const { id, vid } = await params;

    // Per-admin sub-cap — re-ingest is an expensive 1+ LLM-call flow, shared with
    // new ingest. The 100/min `api` section cap was already applied by middleware.
    const rl = ingestLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Questionnaire re-ingest rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    // Scope the version to its questionnaire (404 on unknown / cross-id mismatch).
    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    // Draft-only — re-ingest is a draft editorial operation, not a fork. A
    // launched/archived version is pinned; the admin forks/creates a draft first.
    if (scoped.status !== 'draft') {
      return errorResponse('Only draft versions can be re-ingested', {
        code: 'REINGEST_NOT_DRAFT',
        status: 409,
        details: { status: [`Version is ${scoped.status}; re-ingest requires a draft`] },
      });
    }

    // Guard + identify the upload (size, format, admin metadata, SHA-256).
    const guard = await parseAndGuardUpload(request);
    if (!guard.ok) return guard.response;
    const { file, fileHash, adminMeta } = guard.value;

    // Version-scoped dedup short-circuit: the upload is byte-identical to the
    // version's CURRENT (most recent) source document → no-op (no re-extraction,
    // no writes), returning the unchanged graph counts. Two deliberate scopings:
    //   - Match only the *active* source doc, not any historical one. Re-ingest
    //     appends source docs (prior ones are kept), so a hash that matches a
    //     superseded doc must NOT short-circuit — re-uploading it should re-extract
    //     and restore that structure.
    //   - Only when the admin supplied no goal/audience override. An override is a
    //     real change to apply; a no-op would silently drop it. Supplying one forces
    //     the full re-extract + merge path even for identical bytes.
    const adminSuppliedMeta = adminMeta.goal !== undefined || adminMeta.audience !== undefined;
    const activeSource = await prisma.appQuestionnaireSourceDocument.findFirst({
      where: { versionId: vid },
      orderBy: { createdAt: 'desc' },
      select: { fileHash: true },
    });
    if (activeSource?.fileHash === fileHash && !adminSuppliedMeta) {
      // Count applied changes only, matching the detail/list read models
      // (detail.ts filters status:'applied') so the no-op count can't disagree
      // with what the detail page shows for the same version.
      const [sectionCount, questionCount, changeCount] = await Promise.all([
        prisma.appQuestionnaireSection.count({ where: { versionId: vid } }),
        prisma.appQuestionSlot.count({ where: { versionId: vid } }),
        prisma.appQuestionnaireExtractionChange.count({
          where: { versionId: vid, status: 'applied' },
        }),
      ]);
      log.info('Questionnaire re-ingest deduped (identical document)', {
        adminId,
        questionnaireId: id,
        versionId: vid,
        fileHash,
      });
      return successResponse({
        questionnaireId: id,
        versionId: vid,
        sectionCount,
        questionCount,
        changeCount,
        deduped: true,
      });
    }

    // Parse → scanned/empty detection → extractor dispatch → coherence pre-check.
    const extracted = await extractFromDocument(guard.value, { adminId, log });
    if (!extracted.ok) return extracted.response;
    const { extraction, parsed } = extracted.value;

    let result;
    try {
      result = await reingestVersion({
        versionId: vid,
        extraction,
        admin: adminMeta,
        source: {
          fileName: file.name,
          fileHash,
          byteSize: file.size,
          ...(file.type ? { mimeType: file.type } : {}),
          ...(Array.isArray(parsed.pageInfo) ? { pageCount: parsed.pageInfo.length } : {}),
          warnings: parsed.warnings,
          extractedText: parsed.fullText,
        },
      });
    } catch (err) {
      // Closes the draft-only TOCTOU: the outer status check happens before the
      // (seconds-long) extraction, so a concurrent launch could have flipped the
      // version. The writer re-asserts `status === 'draft'` inside its transaction
      // and throws; map that to the same 409 the outer guard returns, atomically.
      if (err instanceof ReingestNotDraftError) {
        return errorResponse('Only draft versions can be re-ingested', {
          code: 'REINGEST_NOT_DRAFT',
          status: 409,
          details: { status: [err.message] },
        });
      }
      throw err;
    }

    logAdminAction({
      userId: adminId,
      action: 'questionnaire.reingest',
      entityType: 'questionnaire_version',
      entityId: vid,
      metadata: {
        questionnaireId: id,
        versionId: vid,
        sectionCount: result.sectionCount,
        questionCount: result.questionCount,
        changeCount: result.changeCount,
        fileName: file.name,
        fileHash,
      },
      clientIp,
    });

    log.info('Questionnaire re-ingested', {
      adminId,
      questionnaireId: id,
      versionId: vid,
      sectionCount: result.sectionCount,
      questionCount: result.questionCount,
      changeCount: result.changeCount,
    });

    return successResponse({ questionnaireId: id, ...result, deduped: false });
  }
);

export const POST = handleReingest;
