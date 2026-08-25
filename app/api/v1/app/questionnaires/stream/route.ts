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
 * Auth: admin only. Rate limit: the same per-admin ingest sub-cap as the
 * non-streaming route.
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
import { checkAdaptiveScopeCandidacy } from '@/app/api/v1/app/questionnaires/_lib/scope-candidacy';
import {
  canProposeDuringIngest,
  proposeScopeDuringIngest,
  type IngestScopeProposal,
} from '@/app/api/v1/app/questionnaires/_lib/routing-analysis';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
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

/**
 * Wall-clock ceiling — and it is a real ceiling, not a budget that fits.
 *
 * The stages are bounded at 300s (extraction), 60s (verify), 90s (repair) and 20s (the candidacy
 * check), and since F17.22 Phase 2 a flagged document also runs the Routing Analyst inline (180s).
 * Serially that is far more than 300, which is this deployment's ceiling — seven other routes use
 * the same number. Those bounds are worst cases that do not co-occur on a real upload, but the
 * inline proposal is the one stage that can be SKIPPED without failing anything, so it checks the
 * elapsed time first (`canProposeDuringIngest`) and leaves the work to the Topics tab's
 * auto-trigger when the stream has already spent the budget. Being killed mid-stream is the
 * failure worth avoiding: the version is already persisted, but the client never sees `done`, so
 * it reports a failed upload for a questionnaire that exists.
 */
export const maxDuration = 300;

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
    // When the work started, so the optional inline scope proposal can tell whether there is still
    // room for it inside `maxDuration` — see `canProposeDuringIngest`.
    const streamStartedAt = Date.now();
    // The orchestrator runs extract → verify → repair → coherence,
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
    const { extraction, parsed, fidelity } = orchestrated.value;

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

      // F14.15: record what the fidelity critic concluded, now that the version it describes
      // exists. Best-effort — a provenance write must never fail a completed ingest.
      if (fidelity) {
        void recordAiRun({
          subjectKind: 'version',
          subjectId: result.versionId,
          versionId: result.versionId,
          kind: 'extraction_verify',
          status: fidelity.repairOutcome === 'verifier_unavailable' ? 'failed' : 'succeeded',
          provider: fidelity.provider,
          model: fidelity.model,
          outputSnapshot: fidelity.verdicts,
          durationMs: fidelity.durationMs,
          detail: {
            flaggedCount: fidelity.flaggedCount,
            totalCount: fidelity.totalCount,
            repairOutcome: fidelity.repairOutcome,
            fileName: file.name,
          },
          ...(fidelity.repairOutcome === 'verifier_unavailable'
            ? {
                error:
                  'Fidelity critic did not run — agent unavailable or returned an unusable result',
              }
            : {}),
          triggeredByUserId: adminId,
        });
      }

      // Adaptive Scope (P17.19): a cheap, fail-soft triage read over the just-persisted version.
      // Its own phase event so the admin sees why the stream keeps going a little past "saving"
      // rather than reading it as a stall.
      yield {
        type: 'phase',
        phase: 'checking_scope',
        message: 'Checking for conditional routing…',
      };
      const candidacy = await checkAdaptiveScopeCandidacy({
        versionId: result.versionId,
        documentText: parsed.fullText,
        fileName: file.name,
        adminId,
        log,
      });

      // F17.22 Phase 2: the check just said this document describes routing, and the admin is
      // still watching this stream. Propose the topics now rather than on some later visit to a
      // tab they may not know exists — the added time is visible progress rather than a mystery.
      // Fail-soft: `proposeScopeDuringIngest` never throws and never fails the upload.
      let scopeProposal: IngestScopeProposal | null = null;
      const elapsedMs = Date.now() - streamStartedAt;
      if (candidacy?.isCandidate && canProposeDuringIngest(elapsedMs)) {
        yield {
          type: 'phase',
          phase: 'proposing_scope',
          message: 'Working out which parts apply to whom…',
        };
        scopeProposal = await proposeScopeDuringIngest({
          questionnaireId: result.questionnaireId,
          versionId: result.versionId,
          adminId,
          clientIp: clientIP,
          log,
        });
        if (scopeProposal) {
          yield {
            type: 'phase',
            phase: 'proposing_scope',
            message:
              scopeProposal.conditionalCount > 0
                ? `Proposed ${scopeProposal.topicCount} topics, ${scopeProposal.conditionalCount} of them conditional — review them on the Adaptive scope tab.`
                : `Proposed ${scopeProposal.topicCount} topics — review them on the Adaptive scope tab.`,
          };
        }
      } else if (candidacy?.isCandidate) {
        // Skipped, not failed: the verdict is cached on the version, so the Topics tab proposes on
        // the first visit instead. Better than being killed mid-run inside `maxDuration`.
        log.info(
          'scope proposal: ingest already spent the wall-clock budget; leaving it to the tab',
          {
            versionId: result.versionId,
            elapsedMs,
          }
        );
      }

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
        ...(candidacy ? { adaptiveScopeCandidate: candidacy } : {}),
        ...(scopeProposal ? { adaptiveScopeProposal: scopeProposal } : {}),
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
