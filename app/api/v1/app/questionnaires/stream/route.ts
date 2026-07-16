/**
 * Streaming questionnaire ingest (the watch-it-extract surface).
 *
 * POST /api/v1/app/questionnaires/stream
 *   Admin-only SSE. Same pipeline as the non-streaming `POST /questionnaires`
 *   (guard → parse → extract → coherence → persist), but the expensive
 *   parse+extract stretch runs behind a live event stream so a multi-page PDF
 *   (whose extractor LLM call is bounded at 120s, plus a table pass) never trips a
 *   synchronous request's idle timeout. Pre-stream validation (rate limit, guard,
 *   demo-client check) still returns a normal JSON error envelope; once the stream
 *   opens, failures surface as a terminal `error` event and success as a `done`
 *   event carrying the new draft's ids. Mirrors `compose/stream`'s `drive()`.
 *
 * Auth: admin only. Flag: 404 when `APP_QUESTIONNAIRES_ENABLED` is off. Rate limit:
 * the same per-admin ingest sub-cap as the non-streaming route.
 */

import type { NextRequest } from 'next/server';

import { errorResponse } from '@/lib/api/responses';
import { parseApiResponse } from '@/lib/api/parse-response';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { sseResponse } from '@/lib/api/sse';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import {
  deriveTitle,
  parseAndGuardUpload,
} from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';
import { orchestrateExtraction } from '@/app/api/v1/app/questionnaires/_lib/orchestrate-extraction';
import { persistIngestion } from '@/app/api/v1/app/questionnaires/_lib/persist';
import type { ExtractionStreamEvent } from '@/lib/app/questionnaire/ingestion/extraction-stream-events';

/**
 * Convert a pre-built error `Response` from the pipeline into a terminal stream
 * error event. The pipeline helpers return ready-made `errorResponse(...)` objects
 * (the standard `{ success:false, error:{ code, message } }` envelope); mid-stream we
 * can't return those as a status code, so we read the sanitized code/message back out.
 * Parsed through the shared {@link parseApiResponse} validator rather than an unchecked
 * cast, so this can't silently drift from the envelope contract.
 */
async function errorEventFromResponse(response: Response): Promise<ExtractionStreamEvent> {
  const fallback: ExtractionStreamEvent = {
    type: 'error',
    code: 'EXTRACTION_FAILED',
    message: 'Extraction failed. Please try again.',
  };
  try {
    const parsed = await parseApiResponse<unknown>(response);
    if (!parsed.success) {
      return {
        type: 'error',
        code: parsed.error.code ?? fallback.code,
        message: parsed.error.message ?? fallback.message,
      };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

const handleIngestStream = withAdminAuth(async (request: NextRequest, session) => {
  const log = await getRouteLogger(request);
  const clientIP = getClientIP(request);
  const adminId = session.user.id;

  // Per-admin sub-cap — each ingest is an expensive 1+ LLM-call flow (shared cap with
  // the non-streaming route). The 100/min `api` section cap was already applied upstream.
  const rl = ingestLimiter.check(adminId);
  if (!rl.success) {
    log.warn('Questionnaire ingest-stream rate limit exceeded', { adminId, reset: rl.reset });
    return createRateLimitResponse(rl);
  }

  // Guard + identify the upload (size, format, admin metadata, SHA-256). Pre-stream,
  // so a bad upload is a clean JSON 4xx rather than a stream that opens then errors.
  const guard = await parseAndGuardUpload(request);
  if (!guard.ok) return guard.response;
  // Capture the narrowed upload in its own const — control-flow narrowing of `guard.ok`
  // does not carry into the nested `drive()` generator closure below.
  const upload = guard.value;
  const { file, fileHash, adminMeta, requiredMode } = upload;

  // DEMO-ONLY: when attributing on upload, the target client must exist — cheap
  // pre-check for a clean 404 before the expensive extract (mirrors the POST route).
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

  async function* drive(): AsyncGenerator<ExtractionStreamEvent> {
    // The orchestrator runs extract → (verify → repair, when the sub-flag is on) → coherence,
    // yielding real phase events (extracting / verifying / repairing) as it goes. Drain it,
    // re-yielding each event over the stream, then take its returned PipelineResult.
    const orchestrator = orchestrateExtraction(upload, { adminId, log });
    let step = await orchestrator.next();
    while (!step.done) {
      yield step.value;
      step = await orchestrator.next();
    }
    const orchestrated = step.value;
    if (!orchestrated.ok) {
      yield await errorEventFromResponse(orchestrated.response);
      return;
    }
    const { extraction, parsed } = orchestrated.value;

    yield { type: 'phase', phase: 'saving', message: 'Saving the questionnaire…' };
    try {
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
          mode: 'stream',
          demoClientId: demoClientId ?? null,
        },
        clientIp: clientIP,
      });

      log.info('Questionnaire ingested (stream)', {
        adminId,
        questionnaireId: result.questionnaireId,
        versionId: result.versionId,
        sectionCount: result.sectionCount,
        questionCount: result.questionCount,
        changeCount: result.changeCount,
      });

      yield {
        type: 'done',
        questionnaireId: result.questionnaireId,
        versionId: result.versionId,
        sectionCount: result.sectionCount,
        questionCount: result.questionCount,
        changeCount: result.changeCount,
      };
    } catch (err) {
      log.error('Ingest stream: persist failed (response already streamed)', {
        adminId,
        fileName: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
      yield {
        type: 'error',
        code: 'PERSIST_FAILED',
        message: 'The questionnaire was extracted but could not be saved. Please try again.',
      };
    }
  }

  return sseResponse(drive(), { signal: request.signal });
});

export const POST = handleIngestStream;
