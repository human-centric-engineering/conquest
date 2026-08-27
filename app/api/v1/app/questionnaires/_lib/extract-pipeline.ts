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

// Server-only tripwire: this pipeline pulls in `node:crypto` and the `exceljs`-backed
// `xlsx-flatten` (whose browser build uses `new Function`). Prod CSP forbids `'unsafe-eval'`, so a
// client-bundle bleed here would break silently in prod only. Fail the build instead.
import 'server-only';
import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { enforceContentLengthCap } from '@/lib/api/multipart-guard';
import type { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { parseDocument } from '@/lib/orchestration/knowledge/parsers';
import { flattenWorkbook } from '@/lib/app/questionnaire/ingestion/xlsx-flatten';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import {
  EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  QUESTIONNAIRE_EXTRACTOR_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import {
  EXTRACTION_PROGRESS_CONTEXT_KEY,
  type ExtractionProgressSink,
} from '@/lib/app/questionnaire/ingestion/extraction-progress-context';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities';
import type { VerifyCoverage } from '@/lib/app/questionnaire/ingestion/verify-schema';
import {
  ALLOWED_EXTENSIONS,
  getExtension,
  hasAllowedExtension,
  parseAdminMetadata,
  parseExtractTablesFlag,
  parseRequiredMode,
  type AdminMetadata,
  type RequiredMode,
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
  /** Requiredness choice (`'all'` default / `'source'`) — consumed by the ingest route only. */
  requiredMode: RequiredMode;
}

/**
 * What the fidelity critic observed, threaded out of the orchestrator so the caller can persist
 * it against the version once that version exists (F14.15).
 *
 * Before this, the critic's verdicts were computed, used to decide repairs, and then discarded —
 * so a question flagged `suspect` but NOT repaired (because repair failed, or because the
 * >`REPAIR_FLAG_CEILING` systemic-failure bail-out fired) was persisted looking exactly as clean
 * as one the critic had confirmed. Nobody could tell the difference afterwards.
 */
export interface FidelityRecord {
  /** Resolved verifier binding, for attribution after the agent's model changes. */
  provider: string;
  model: string;
  /** Every verdict the critic returned. */
  verdicts: unknown;
  /** How many it flagged `suspect`. */
  flaggedCount: number;
  /** Total questions checked. */
  totalCount: number;
  /** What happened to the flagged ones. */
  repairOutcome:
    'none_flagged' | 'repaired' | 'repair_failed' | 'skipped_systemic' | 'verifier_unavailable';
  /**
   * USD billed for the verify call, so the `extraction_verify` provenance row can price itself.
   * `null` when the critic never reached a provider (unavailable agent, dispatch failure) — a real
   * answer, distinct from a call that genuinely cost nothing.
   */
  costUsd: number | null;
  /**
   * The critic's read on the question COUNT — the axis its per-question verdicts cannot see.
   * `null` when the critic did not run or did not report one. See {@link VerifyCoverage}.
   */
  coverage: VerifyCoverage | null;
  /**
   * How many editorial changes the extractor made that it is instructed NOT to make — splitting a
   * compound question in two, or merging two into one. Both are real improvements and both belong
   * to the judge panel, where an author reviews them; done silently at ingest they make the same
   * document extract to a different question count on different runs (22 vs 28, measured).
   *
   * Deterministic, unlike `coverage`: it counts the extractor's own change entries rather than
   * asking a model. It cannot be un-done here — the halves are already separate by the time this is
   * read — so it is reported, not enforced. A non-zero value on a build carrying the "do not split"
   * instruction means the instruction is not landing.
   */
  disallowedEditCount: number;
  /**
   * How many persisted question prompts match NEITHER a span of the source document NOR the `after`
   * prompt of any change record the extractor filed. That is an edit nobody can see: the editorial
   * log is what the review surface renders and what F2.3 reverts, so a reworded prompt with no
   * record is unreviewable and un-revertable, and the Structure editor shows it as if the author
   * had written it.
   *
   * Deterministic, like {@link disallowedEditCount} — it compares strings, not judgement, which is
   * the point. The fidelity critic marks reworded questions `ok` (correctly: they still ask the
   * same thing), so no per-question verdict can catch this; only the source can.
   *
   * Two known sources of a legitimate non-zero count, both worth seeing rather than suppressing: a
   * question whose prompt is synthesised rather than quoted (a merged matrix stem), and a repair
   * `correct` — `mergeRepairs` replaces the whole question but records only its type/config,
   * so a prompt the specialist changed on the way past is unattributed for exactly the same reason.
   * Reported, never enforced: by the time it is readable the questions already exist.
   */
  unattributedPromptCount: number;
  durationMs: number;
}

/** The extractor output plus the parsed document it came from (source-doc provenance). */
export interface ExtractedDocument {
  extraction: ExtractQuestionnaireStructureData;
  parsed: Awaited<ReturnType<typeof parseDocument>>;
  /** Null when the verifier never ran (not seeded, or it threw). */
  fidelity: FidelityRecord | null;
}

export type PipelineResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/** Title for the new questionnaire — the parsed document title, else the filename. */
export function deriveTitle(parsedTitle: string, fileName: string): string {
  const trimmed = parsedTitle.trim();
  if (trimmed.length > 0) return trimmed;
  const withoutExt = fileName.replace(/\.[^./\\]+$/, '').trim();
  return withoutExt.length > 0 ? withoutExt : fileName;
}

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
  // Requiredness choice (throws ValidationError → 400 on an unrecognised value).
  const requiredMode = parseRequiredMode(formData);

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash('sha256').update(buffer).digest('hex');

  return { ok: true, value: { file, buffer, fileHash, adminMeta, extractTables, requiredMode } };
}

/**
 * Parse a guarded upload to text, rejecting a document with nothing in it to read.
 *
 * Steps 10–11 of the ingest pipeline, lifted out so the two callers that need TEXT without an
 * extraction can have it: {@link extractFromDocument} below, and the supplementary-document attach
 * route, which stores a companion file's text for the Routing Analyst and never touches structure.
 *
 * Every failure keeps the exact status and envelope the ingest route has always returned —
 * `PARSE_FAILED`, `SCANNED_DOCUMENT`, `EMPTY_DOCUMENT` — because those codes are what the upload
 * dialog already knows how to explain.
 */
export async function parseUploadToText(
  upload: GuardedUpload,
  log: RouteLogger
): Promise<PipelineResult<Awaited<ReturnType<typeof parseDocument>>>> {
  const { file, buffer, extractTables } = upload;
  const fileExt = getExtension(file.name);

  let parsed: Awaited<ReturnType<typeof parseDocument>>;
  try {
    // Spreadsheets take an app-tier flattener (faithful tab/column → Markdown)
    // rather than the shared KB parser router, which has no `.xlsx` branch. The
    // flattener makes no question/structure decisions — the extractor agent does.
    parsed =
      fileExt === '.xlsx'
        ? await flattenWorkbook(buffer, file.name)
        : await parseDocument(buffer, file.name, { extractTables });
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
  const hasNoText = parsed.fullText.trim().length === 0;
  const pdfAllPagesBlank =
    fileExt === '.pdf' &&
    Array.isArray(parsed.pageInfo) &&
    parsed.pageInfo.length > 0 &&
    parsed.pageInfo.every((page) => !page.hasText);
  if (hasNoText || pdfAllPagesBlank) {
    if (fileExt === '.pdf') {
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

  return { ok: true, value: parsed };
}

/**
 * Steps 12–13 of the ingest pipeline: parse the document to text (via
 * {@link parseUploadToText}), load the extractor agent, dispatch the extraction
 * capability, and run the coherence pre-check. Returns the validated extractor
 * output plus the parsed document (the caller needs its title/pageInfo/warnings/
 * fullText for the source-document row). Maps every failure to the exact
 * status/envelope the inline F1.1 route returned.
 */
export async function extractFromDocument(
  upload: GuardedUpload,
  ctx: {
    adminId: string;
    log: RouteLogger;
    /**
     * Optional live "questions so far" sink. When present (the streaming ingest
     * route), the extractor runs its first pass STREAMED and reports a rising
     * count through this callback; absent (non-streaming ingest / re-ingest), the
     * extractor keeps its single blocking call. Rides the dispatcher's
     * `entityContext` seam — see {@link ExtractionProgressSink}.
     */
    onExtractionProgress?: ExtractionProgressSink;
  }
): Promise<PipelineResult<ExtractedDocument>> {
  const { file, adminMeta } = upload;
  const { adminId, log, onExtractionProgress } = ctx;

  const parseResult = await parseUploadToText(upload, log);
  if (!parseResult.ok) return parseResult;
  const parsed = parseResult.value;

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

  // Flush the built-in + app capability handlers into the dispatcher before dispatching. Upload is
  // often the FIRST capability touch on a fresh server process (an admin ingesting a questionnaire
  // before any chat/turn has run), and the dispatcher does not lazy-register — without this the
  // handler map is empty and the dispatch returns `unknown_capability`. Same one-shot, idempotent
  // flush the data-slot and live turn loops perform.
  registerBuiltInCapabilities();

  const dispatch = await capabilityDispatcher.dispatch(
    EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
    {
      documentText: parsed.fullText,
      fileName: file.name,
      ...(file.type ? { mediaType: file.type } : {}),
      ...(adminMeta.goal !== undefined ? { adminProvidedGoal: adminMeta.goal } : {}),
      ...(adminMeta.audience !== undefined ? { adminProvidedAudience: adminMeta.audience } : {}),
      ...(adminMeta.instructions !== undefined
        ? { adminProvidedInstructions: adminMeta.instructions }
        : {}),
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
        // Only present for the streaming route — its presence is what flips the
        // capability onto the streamed, count-reporting extraction path.
        ...(onExtractionProgress
          ? { [EXTRACTION_PROGRESS_CONTEXT_KEY]: onExtractionProgress }
          : {}),
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

  // Raw path — no fidelity critic runs here, so there is nothing to record.
  return { ok: true, value: { extraction, parsed, fidelity: null } };
}
