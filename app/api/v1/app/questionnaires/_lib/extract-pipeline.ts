/**
 * Shared ingest extraction pipeline (F2.4 — factored out of the F1.1 ingest route).
 *
 * The "uploaded bytes → validated extractor output" stretch is identical for a
 * **new ingest** (`POST /questionnaires`) and a **re-ingest**
 * (`POST …/versions/:vid/reingest`). It lives here as two helpers so both routes
 * single-source it; the **divergent** steps stay in each handler:
 *   - the SHA-256 dedup (new-ingest is global → 409; re-ingest is version-scoped
 *     → 200 no-op) runs between the two helpers, on the returned `fileHash`;
 *   - persistence (create a questionnaire vs. replace a draft graph) runs after.
 *
 * Each helper returns a discriminated union: `{ ok: true, … }` with the data the
 * handler needs, or `{ ok: false, response }` carrying the ready-made error
 * `Response` (same status/envelope the inline F1.1 route returned). The F1.1
 * ingest route's integration tests are the behaviour-preserving regression net.
 */

import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import type { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';

import {
  EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import {
  ALLOWED_EXTENSIONS,
  getExtension,
  hasAllowedExtension,
  parseAdminMetadata,
  parseExtractTablesFlag,
  type AdminMetadata,
} from '@/app/api/v1/app/questionnaires/_lib/upload-input';
import {
  assertPersistable,
  IncoherentExtractionError,
} from '@/app/api/v1/app/questionnaires/_lib/persist';

type RouteLogger = Awaited<ReturnType<typeof getRouteLogger>>;

/**
 * Decoded upload size cap, 25 MB. A questionnaire is a single document, not the
 * corpus-sized inputs the knowledge KB accepts — generous for a long DOCX/PDF
 * without the post-parse memory footprint of a 50 MB file.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Pre-parse body cap: upload cap + headroom for multipart boundaries + form fields. */
export const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 4 * 1024;

/** The validated, identified upload — before dedup, before the document is parsed. */
export interface GuardedUpload {
  file: File;
  /** Raw upload bytes (for hashing / the source-document row). */
  buffer: Buffer;
  /** SHA-256 of the raw upload bytes (lowercase hex) — the dedup key. */
  fileHash: string;
  adminMeta: AdminMetadata;
  /** PDF table-extraction flag, consumed by {@link extractFromDocument}. */
  extractTables: boolean;
}

/** The extractor output plus the parsed document it came from (source-doc provenance). */
export interface ExtractedDocument {
  extraction: ExtractQuestionnaireStructureData;
  parsed: Awaited<ReturnType<typeof parseDocument>>;
}

type PipelineResult<T> = { ok: true; value: T } | { ok: false; response: Response };

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

/**
 * Steps 2–8 of the ingest pipeline: body-size guard, multipart parse, `file`
 * field check, post-parse size check, extension allowlist, admin-metadata +
 * extract-tables parse, and the SHA-256 hash. Stops **before** dedup (which
 * differs per flow) and before the document is parsed (so a dup short-circuits
 * without paying the parse). Throws {@link ValidationError} (→ 400) only via
 * `parseAdminMetadata`/the multipart parse, matching the F1.1 route.
 */
export async function parseAndGuardUpload(
  request: NextRequest
): Promise<PipelineResult<GuardedUpload>> {
  // Pre-parse body-size guard — reject oversize bodies before formData() allocates.
  const oversize = enforceContentLengthCap(request, {
    maxBytes: MAX_REQUEST_BYTES,
    errorCode: 'FILE_TOO_LARGE',
    errorMessage: 'File exceeds size limit',
    details: { file: [`Maximum size is ${MAX_UPLOAD_BYTES} bytes`] },
  });
  if (oversize) return { ok: false, response: oversize };

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
    return {
      ok: false,
      response: errorResponse('File exceeds size limit', {
        code: 'FILE_TOO_LARGE',
        status: 413,
        details: { file: [`Maximum size is ${MAX_UPLOAD_BYTES} bytes`] },
      }),
    };
  }

  if (!hasAllowedExtension(file.name)) {
    return {
      ok: false,
      response: errorResponse('Unsupported file type', {
        code: 'UNSUPPORTED_FORMAT',
        status: 400,
        details: { file: [`Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`] },
      }),
    };
  }

  // Admin-supplied goal/audience (throws ValidationError → 400 on bad audience).
  const adminMeta = parseAdminMetadata(formData);
  const extractTables = parseExtractTablesFlag(formData);

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash('sha256').update(buffer).digest('hex');

  return { ok: true, value: { file, buffer, fileHash, adminMeta, extractTables } };
}

/**
 * Steps 10–13 of the ingest pipeline: parse the document to text, detect a
 * scanned/empty upload, load the extractor agent, dispatch the extraction
 * capability, and run the coherence pre-check. Returns the validated extractor
 * output plus the parsed document (the caller needs its title/pageInfo/warnings/
 * fullText for the source-document row). Maps every failure to the exact
 * status/envelope the inline F1.1 route returned.
 */
export async function extractFromDocument(
  upload: GuardedUpload,
  ctx: { adminId: string; log: RouteLogger }
): Promise<PipelineResult<ExtractedDocument>> {
  const { file, buffer, adminMeta, extractTables } = upload;
  const { adminId, log } = ctx;

  let parsed: Awaited<ReturnType<typeof parseDocument>>;
  try {
    parsed = await parseDocument(buffer, file.name, { extractTables });
  } catch (err) {
    log.warn('Questionnaire parse failed', {
      fileName: file.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      response: errorResponse('Could not parse the uploaded document', {
        code: 'PARSE_FAILED',
        status: 422,
        details: { file: ['The document could not be read as a supported format'] },
      }),
    };
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
      return {
        ok: false,
        response: errorResponse('The PDF appears to be scanned — no extractable text', {
          code: 'SCANNED_DOCUMENT',
          status: 422,
          details: { file: ['Provide a text-based PDF or run OCR before uploading'] },
        }),
      };
    }
    return {
      ok: false,
      response: errorResponse('The document contains no extractable text', {
        code: 'EMPTY_DOCUMENT',
        status: 422,
        details: { file: ['The uploaded document is empty'] },
      }),
    };
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
    return {
      ok: false,
      response: errorResponse('The questionnaire extractor is not configured', {
        code: 'EXTRACTOR_NOT_CONFIGURED',
        status: 503,
      }),
    };
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
    return {
      ok: false,
      response: errorResponse(dispatch.error?.message ?? 'Extraction failed', {
        code: dispatchErrorCode(status),
        status,
        ...(dispatch.error?.code ? { details: { capabilityError: dispatch.error.code } } : {}),
      }),
    };
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
      return {
        ok: false,
        response: errorResponse(err.message, {
          code: 'EXTRACTION_INCOHERENT',
          status: 422,
          details: { orphanSectionOrdinals: err.orphanSectionOrdinals },
        }),
      };
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

  return { ok: true, value: { extraction, parsed } };
}
