/**
 * Questionnaire ingestion + list endpoint (F1.1 / PR4; list added P2 / F2.1a).
 *
 * GET /api/v1/app/questionnaires
 *   Paginated, admin-only list of questionnaires, each enriched with its latest
 *   version and that version's section / question counts (computed in a fixed
 *   number of queries — no per-row N+1). Query params: page, limit, q (title
 *   search), status, sortBy, sortOrder. Read-only; the read model lives in
 *   `_lib/list.ts`.
 *
 * POST /api/v1/app/questionnaires
 *   Multipart upload of a questionnaire document (.pdf / .docx / .md / .txt). The
 *   route parses the bytes to text, dispatches the extractor capability for an
 *   opinionated structured extraction (sections, questions, inferred goal/
 *   audience, and a per-decision editorial change log), and persists the whole
 *   graph in one transaction. Returns the new questionnaire/version ids, counts,
 *   resolved goal/audience, and per-field provenance. **API-only — no UI** (P2
 *   builds the review/edit surface that consumes the change log).
 *
 * Pipeline (the order is load-bearing):
 *   flag-gate → withAdminAuth → per-admin sub-cap → content-length guard →
 *   multipart parse → extension allowlist → admin-metadata parse → demo-client
 *   existence check → SHA-256 dedup → document parse → scanned/empty detection →
 *   capability dispatch → coherence check → transactional persist → admin audit → 201.
 *
 * Auth: admin only. Flag: 404 when `APP_QUESTIONNAIRES_ENABLED` is off (the app
 * is dark). Rate limit: inherits the 100/min `api` section cap automatically; adds
 * a tighter per-admin sub-cap here because each ingest is ≥1 reasoning LLM call.
 */

import type { NextRequest } from 'next/server';

import { errorResponse, paginatedResponse, successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  deriveTitle,
  extractFromDocument,
  parseAndGuardUpload,
} from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';
import { persistIngestion } from '@/app/api/v1/app/questionnaires/_lib/persist';
import {
  listQuestionnaires,
  listQuestionnairesQuerySchema,
} from '@/app/api/v1/app/questionnaires/_lib/list';

const handleIngest = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIP = getClientIP(request);
  const adminId = session.user.id;

  // Per-admin sub-cap — each ingest is an expensive 1+ LLM-call flow. Keyed on
  // the admin id (cost/budget attach to them), not the IP. The 100/min `api`
  // section cap was already applied by the middleware.
  const rl = ingestLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Questionnaire ingest rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  // Guard + identify the upload (size, format, admin metadata, SHA-256).
  const guard = await parseAndGuardUpload(request);
  if (!guard.ok) return guard.response;
  const { file, fileHash, adminMeta, requiredMode } = guard.value;

  // DEMO-ONLY (F2.5.1): when attributing on upload, the target client must exist.
  // Cheap pre-check (before the expensive extract) for a clean 404 rather than a
  // foreign-key 500 at persist time — mirrors the PATCH attribution guard.
  let demoClientId: string | undefined;
  if (adminMeta.demoClientId !== undefined) {
    const client = await prisma.appDemoClient.findUnique({
      where: { id: adminMeta.demoClientId },
      select: { id: true },
    });
    if (!client) {
      return errorResponse('Demo client not found', { code: 'DEMO_CLIENT_NOT_FOUND', status: 404 });
    }
    demoClientId = client.id;
  }

  // DEMO-ONLY: the global SHA-256 dedup pre-empt was removed so re-uploading the
  // exact same document creates a fresh questionnaire/version instead of a 409.
  // The fileHash is still computed and persisted on the source document (used by
  // F2.4 re-ingest, which scopes its own dedup to the target version). Re-add the
  // global pre-empt here if duplicate-upload UX matters again outside the demo.

  // Parse → scanned/empty detection → extractor dispatch → coherence pre-check.
  const extracted = await extractFromDocument(guard.value, { adminId, log });
  if (!extracted.ok) return extracted.response;
  const { extraction, parsed } = extracted.value;

  // Admin-supplied name wins over the document-derived title.
  const documentTitle = adminMeta.title ?? deriveTitle(parsed.title, file.name);
  const result = await persistIngestion({
    documentTitle,
    ...(demoClientId !== undefined ? { demoClientId } : {}),
    extraction,
    admin: adminMeta,
    requiredness: requiredMode,
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

  logAdminAction({
    userId: adminId,
    action: 'questionnaire.ingest',
    entityType: 'questionnaire',
    entityId: result.versionId,
    entityName: documentTitle,
    metadata: {
      questionnaireId: result.questionnaireId,
      versionId: result.versionId,
      sectionCount: result.sectionCount,
      questionCount: result.questionCount,
      changeCount: result.changeCount,
      fileName: file.name,
      fileHash,
      demoClientId: demoClientId ?? null,
    },
    clientIp: clientIP,
  });

  log.info('Questionnaire ingested', {
    adminId,
    questionnaireId: result.questionnaireId,
    versionId: result.versionId,
    sectionCount: result.sectionCount,
    questionCount: result.questionCount,
    changeCount: result.changeCount,
  });

  return successResponse(
    {
      questionnaireId: result.questionnaireId,
      versionId: result.versionId,
      sectionCount: result.sectionCount,
      questionCount: result.questionCount,
      changeCount: result.changeCount,
      goal: result.goal,
      audience: result.audience,
      fieldProvenance: result.fieldProvenance,
    },
    undefined,
    { status: 201 }
  );
});

const handleList = withAdminAuth(async (request: NextRequest) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const query = validateQueryParams(searchParams, listQuestionnairesQuerySchema);

  const { items, total } = await listQuestionnaires(query);

  log.info('Questionnaires listed', {
    count: items.length,
    total,
    page: query.page,
    limit: query.limit,
  });

  return paginatedResponse(items, { page: query.page, limit: query.limit, total });
});

export const GET = handleList;

export const POST = handleIngest;
