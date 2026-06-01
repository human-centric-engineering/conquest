/**
 * Questionnaire ingestion endpoint (F1.1 / PR4).
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
 *   multipart parse → extension allowlist → admin-metadata parse → SHA-256 dedup →
 *   document parse → scanned/empty detection → capability dispatch → coherence
 *   check → transactional persist → admin audit → 201.
 *
 * Auth: admin only. Flag: 404 when `APP_QUESTIONNAIRES_ENABLED` is off (the app
 * is dark). Rate limit: inherits the 100/min `api` section cap automatically; adds
 * a tighter per-admin sub-cap here because each ingest is ≥1 reasoning LLM call.
 */

import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { ensureQuestionnairesEnabled } from '@/lib/app/questionnaire/feature-flag';
import {
  EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  ALLOWED_EXTENSIONS,
  getExtension,
  hasAllowedExtension,
  parseAdminMetadata,
  parseExtractTablesFlag,
} from '@/app/api/v1/app/questionnaires/_lib/upload-input';
import {
  assertPersistable,
  IncoherentExtractionError,
  persistIngestion,
} from '@/app/api/v1/app/questionnaires/_lib/persist';

/**
 * Decoded upload size cap, 25 MB. A questionnaire is a single document, not the
 * corpus-sized inputs the knowledge KB accepts — generous for a long DOCX/PDF
 * without the post-parse memory footprint of a 50 MB file.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Pre-parse body cap: upload cap + headroom for multipart boundaries + form fields. */
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 4 * 1024;

/** Map a capability dispatch error code to an HTTP status. */
function dispatchErrorStatus(code: string | undefined): number {
  switch (code) {
    case 'rate_limited':
      return 429;
    case 'invalid_args':
      return 400;
    // "The extractor isn't available to run" — distinct from "extraction was
    // attempted and failed" (502 default). The last two are seeded-off for this
    // capability but routed defensively so a future config change can't surface
    // as a misleading 502.
    case 'no_provider_configured':
    case 'provider_unavailable':
    case 'capability_inactive':
    case 'capability_disabled_for_agent':
    case 'unknown_capability':
    case 'capability_quarantined':
    case 'requires_approval':
      return 503;
    default:
      // extraction_failed, execution_error, … — the LLM or its config let us
      // down mid-extraction. 502: the upstream extraction step failed.
      return 502;
  }
}

/** Top-level error code surfaced to the client for a dispatch failure. */
function dispatchErrorCode(status: number): string {
  if (status === 429) return 'EXTRACTOR_RATE_LIMITED';
  if (status === 400) return 'INVALID_EXTRACTION_ARGS';
  if (status === 503) return 'EXTRACTOR_UNAVAILABLE';
  return 'EXTRACTION_FAILED';
}

/** Title for the new questionnaire — the parsed document title, else the filename. */
function deriveTitle(parsedTitle: string, fileName: string): string {
  const trimmed = parsedTitle.trim();
  if (trimmed.length > 0) return trimmed;
  const withoutExt = fileName.replace(/\.[^./\\]+$/, '').trim();
  return withoutExt.length > 0 ? withoutExt : fileName;
}

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

  // Pre-parse body-size guard — reject oversize bodies before formData() allocates.
  const oversize = enforceContentLengthCap(request, {
    maxBytes: MAX_REQUEST_BYTES,
    errorCode: 'FILE_TOO_LARGE',
    errorMessage: 'File exceeds size limit',
    details: { file: [`Maximum size is ${MAX_UPLOAD_BYTES} bytes`] },
  });
  if (oversize) return oversize;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new ValidationError('Expected multipart/form-data body');
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    throw new ValidationError('Missing or invalid file field', {
      file: ['A file must be supplied in the `file` form field'],
    });
  }

  // Post-parse size check (catches a missing/lying Content-Length).
  if (file.size > MAX_UPLOAD_BYTES) {
    return errorResponse('File exceeds size limit', {
      code: 'FILE_TOO_LARGE',
      status: 413,
      details: { file: [`Maximum size is ${MAX_UPLOAD_BYTES} bytes`] },
    });
  }

  if (!hasAllowedExtension(file.name)) {
    return errorResponse('Unsupported file type', {
      code: 'UNSUPPORTED_FORMAT',
      status: 400,
      details: { file: [`Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`] },
    });
  }

  // Admin-supplied goal/audience (throws ValidationError → 400 on bad audience).
  const adminMeta = parseAdminMetadata(formData);
  const extractTables = parseExtractTablesFlag(formData);

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash('sha256').update(buffer).digest('hex');

  // SHA-256 dedup — best-effort: the exact same bytes were already ingested, so
  // surface the existing ids instead of creating a near-identical questionnaire.
  // Deliberately NOT backed by a DB unique constraint: F2.4 re-ingest will
  // legitimately attach the same hash to a new version, so a global unique on
  // fileHash would be wrong. The check is therefore a friendly pre-empt, not a
  // race-proof guarantee — two interleaved identical uploads could both pass, at
  // worst yielding a duplicate the admin can delete. F2.4 owns true re-ingest.
  const duplicate = await prisma.appQuestionnaireSourceDocument.findFirst({
    where: { fileHash },
    select: { versionId: true, version: { select: { questionnaireId: true } } },
  });
  if (duplicate) {
    return errorResponse('This document has already been ingested', {
      code: 'DUPLICATE_DOCUMENT',
      status: 409,
      details: {
        questionnaireId: duplicate.version.questionnaireId,
        versionId: duplicate.versionId,
      },
    });
  }

  let parsed: Awaited<ReturnType<typeof parseDocument>>;
  try {
    parsed = await parseDocument(buffer, file.name, { extractTables });
  } catch (err) {
    log.warn('Questionnaire parse failed', {
      fileName: file.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Could not parse the uploaded document', {
      code: 'PARSE_FAILED',
      status: 422,
      details: { file: ['The document could not be read as a supported format'] },
    });
  }

  // Scanned / empty detection. A scanned PDF yields no extractable text — distinct
  // from a genuinely empty file so the admin knows OCR is the missing step.
  const ext = getExtension(file.name);
  const hasNoText = parsed.fullText.trim().length === 0;
  const pdfAllPagesBlank =
    ext === '.pdf' &&
    Array.isArray(parsed.pageInfo) &&
    parsed.pageInfo.length > 0 &&
    parsed.pageInfo.every((page) => !page.hasText);
  if (hasNoText || pdfAllPagesBlank) {
    if (ext === '.pdf') {
      return errorResponse('The PDF appears to be scanned — no extractable text', {
        code: 'SCANNED_DOCUMENT',
        status: 422,
        details: { file: ['Provide a text-based PDF or run OCR before uploading'] },
      });
    }
    return errorResponse('The document contains no extractable text', {
      code: 'EMPTY_DOCUMENT',
      status: 422,
      details: { file: ['The uploaded document is empty'] },
    });
  }

  // Load the extractor agent — provider-agnostic binding + cost attribution.
  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG },
    select: { id: true, provider: true, model: true, fallbackProviders: true },
  });
  if (!agent) {
    log.error('Questionnaire extractor agent not seeded', {
      slug: QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
    });
    return errorResponse('The questionnaire extractor is not configured', {
      code: 'EXTRACTOR_NOT_CONFIGURED',
      status: 503,
    });
  }

  const dispatch = await capabilityDispatcher.dispatch(
    EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
    {
      documentText: parsed.fullText,
      fileName: file.name,
      ...(file.type ? { mediaType: file.type } : {}),
      ...(adminMeta.goal !== undefined ? { adminProvidedGoal: adminMeta.goal } : {}),
      ...(adminMeta.audience !== undefined ? { adminProvidedAudience: adminMeta.audience } : {}),
    },
    {
      userId: adminId,
      agentId: agent.id,
      entityContext: {
        extractorAgent: {
          provider: agent.provider,
          model: agent.model,
          fallbackProviders: agent.fallbackProviders,
        },
      },
    }
  );

  if (!dispatch.success || !dispatch.data) {
    const status = dispatchErrorStatus(dispatch.error?.code);
    log.warn('Questionnaire extraction failed', {
      adminId,
      fileName: file.name,
      capabilityError: dispatch.error?.code,
      status,
    });
    return errorResponse(dispatch.error?.message ?? 'Extraction failed', {
      code: dispatchErrorCode(status),
      status,
      ...(dispatch.error?.code ? { details: { capabilityError: dispatch.error.code } } : {}),
    });
  }

  // Internal, schema-validated capability output — narrow at the dispatch boundary.
  const extraction = dispatch.data as ExtractQuestionnaireStructureData;

  // Coherence pre-check before opening a transaction: every question must map to
  // a declared section. A failure is a typed 422, not a half-written graph.
  try {
    assertPersistable(extraction);
  } catch (err) {
    if (err instanceof IncoherentExtractionError) {
      log.warn('Questionnaire extraction incoherent', {
        adminId,
        orphanSectionOrdinals: err.orphanSectionOrdinals,
      });
      return errorResponse(err.message, {
        code: 'EXTRACTION_INCOHERENT',
        status: 422,
        details: { orphanSectionOrdinals: err.orphanSectionOrdinals },
      });
    }
    // assertPersistable is pure and only throws IncoherentExtractionError today;
    // anything else is an unexpected programming error. Re-throw to handleAPIError
    // (500), but leave the same operation breadcrumb the rest of the handler does.
    log.error('Questionnaire coherence check threw unexpectedly', {
      adminId,
      fileName: file.name,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const documentTitle = deriveTitle(parsed.title, file.name);
  const result = await persistIngestion({
    documentTitle,
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

export async function POST(request: NextRequest): Promise<Response> {
  // Flag gate first — a switched-off app is indistinguishable from a missing route.
  const blocked = await ensureQuestionnairesEnabled();
  if (blocked) return blocked;
  return handleIngest(request);
}
