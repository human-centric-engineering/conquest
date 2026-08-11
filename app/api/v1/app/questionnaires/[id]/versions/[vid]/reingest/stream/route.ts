/**
 * Streaming questionnaire re-ingest (the watch-it-extract twin of F2.4's re-ingest).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/reingest/stream
 *   Admin-only SSE. Same pipeline as the non-streaming `POST …/reingest`
 *   (scope-404 → draft-only 409 → guard → version-scoped dedup → parse + extract →
 *   transactional replace), but the expensive extract stretch runs behind a live
 *   event stream — so the admin watches the *real* phases (and the rising
 *   "N questions so far" count) instead of a scripted ticker, exactly as the new-ingest
 *   dialog does. Mirrors `…/questionnaires/stream`'s `drive()`.
 *
 * Pre-stream validation (rate limit, scope, draft-only, upload guard) still returns a
 * normal JSON error envelope; once the stream opens, a failure is a terminal `error`
 * event (never a 5xx) and success is a terminal `done` event carrying the version's new
 * counts. The version-scoped dedup no-op rides the same `done` event with
 * `deduped: true`, so the client has one terminal path.
 *
 * Differs from the non-streaming route at exactly one seam beyond the transport: it
 * drives {@link orchestrateExtraction} (extract → verify → repair → coherence) rather
 * than the single blocking `extractFromDocument` pass — the same upgrade the new-ingest
 * stream route gets, and fail-soft throughout.
 *
 * Auth: admin only. Rate limit: the same per-admin `ingestLimiter` sub-cap as new
 * ingest and the non-streaming re-ingest.
 */

import { errorResponse } from '@/lib/api/responses';
import { parseApiResponse } from '@/lib/api/parse-response';
import { getRouteLogger } from '@/lib/api/context';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { getClientIP } from '@/lib/security/ip';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { sseResponse } from '@/lib/api/sse';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import type { ExtractionStreamEvent } from '@/lib/app/questionnaire/ingestion/extraction-stream-events';

import { ingestLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';
import { loadScopedVersion } from '@/app/api/v1/app/questionnaires/_lib/authoring-routes';
import { parseAndGuardUpload } from '@/app/api/v1/app/questionnaires/_lib/extract-pipeline';
import { orchestrateExtraction } from '@/app/api/v1/app/questionnaires/_lib/orchestrate-extraction';
import {
  ReingestNotDraftError,
  reingestVersion,
} from '@/app/api/v1/app/questionnaires/_lib/reingest';

/**
 * Convert a pre-built error `Response` from the pipeline into a terminal stream error
 * event. Mid-stream we can't return a status code, so read the sanitized code/message
 * back out of the standard envelope — through the shared {@link parseApiResponse}
 * validator rather than an unchecked cast, so this can't drift from the contract.
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

const handleReingestStream = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const adminId = session.user.id;
    const { id, vid } = await params;

    // Per-admin sub-cap — re-ingest is an expensive 1+ LLM-call flow, shared with new
    // ingest. The 100/min `api` section cap was already applied by middleware.
    const rl = ingestLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Questionnaire re-ingest-stream rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    // Scope the version to its questionnaire (404 on unknown / cross-id mismatch).
    const scoped = await loadScopedVersion(id, vid);
    if (!scoped) {
      return errorResponse('Questionnaire version not found', { code: 'NOT_FOUND', status: 404 });
    }

    // Draft-only — re-ingest is a draft editorial operation, not a fork. The writer
    // re-asserts this inside its transaction too (the TOCTOU close).
    if (scoped.status !== 'draft') {
      return errorResponse('Only draft versions can be re-ingested', {
        code: 'REINGEST_NOT_DRAFT',
        status: 409,
        details: { status: [`Version is ${scoped.status}; re-ingest requires a draft`] },
      });
    }

    // Guard + identify the upload (size, format, admin metadata, SHA-256). Pre-stream,
    // so a bad upload is a clean JSON 4xx rather than a stream that opens then errors.
    const guard = await parseAndGuardUpload(request);
    if (!guard.ok) return guard.response;
    // Capture the narrowed upload in its own const — control-flow narrowing of `guard.ok`
    // does not carry into the nested `drive()` generator closure below.
    const upload = guard.value;
    const { file, fileHash, adminMeta } = upload;

    // Version-scoped dedup short-circuit — identical to the non-streaming route: matches
    // only the version's CURRENT (most recent) source doc, and only when the admin supplied
    // no goal/audience override (an override is a real change that must not be dropped).
    // Resolved pre-stream so an identical re-upload costs nothing; surfaced on the same
    // terminal `done` event with `deduped: true`.
    const adminSuppliedMeta = adminMeta.goal !== undefined || adminMeta.audience !== undefined;
    const activeSource = await prisma.appQuestionnaireSourceDocument.findFirst({
      where: { versionId: vid },
      orderBy: { createdAt: 'desc' },
      select: { fileHash: true },
    });
    const isDeduped = activeSource?.fileHash === fileHash && !adminSuppliedMeta;
    // Count applied changes only, matching the detail/list read models (detail.ts filters
    // status:'applied') so the no-op count can't disagree with what the detail page shows.
    const dedupedCounts = isDeduped
      ? await Promise.all([
          prisma.appQuestionnaireSection.count({ where: { versionId: vid } }),
          prisma.appQuestionSlot.count({ where: { versionId: vid } }),
          prisma.appQuestionnaireExtractionChange.count({
            where: { versionId: vid, status: 'applied' },
          }),
        ])
      : null;

    async function* drive(): AsyncGenerator<ExtractionStreamEvent> {
      if (dedupedCounts) {
        const [sectionCount, questionCount, changeCount] = dedupedCounts;
        log.info('Questionnaire re-ingest deduped (identical document)', {
          adminId,
          questionnaireId: id,
          versionId: vid,
          fileHash,
        });
        yield {
          type: 'done',
          questionnaireId: id,
          versionId: vid,
          sectionCount,
          questionCount,
          changeCount,
          deduped: true,
        };
        return;
      }

      // The orchestrator runs extract → verify → repair → coherence, yielding real phase
      // events (including the rising "N questions so far" count) as it goes. Drain it,
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

      yield { type: 'phase', phase: 'saving', message: 'Replacing the draft’s structure…' };
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
        // Closes the draft-only TOCTOU: a concurrent launch during the (seconds-long)
        // extraction is caught by the writer's in-transaction re-assert. The stream is
        // already open, so it surfaces as a terminal error event carrying the same code.
        if (err instanceof ReingestNotDraftError) {
          yield { type: 'error', code: 'REINGEST_NOT_DRAFT', message: err.message };
          return;
        }
        log.error('Re-ingest stream: replace failed (response already streamed)', {
          adminId,
          versionId: vid,
          fileName: file.name,
          error: err instanceof Error ? err.message : String(err),
        });
        yield {
          type: 'error',
          code: 'PERSIST_FAILED',
          message:
            'The document was extracted but the draft could not be replaced. Please try again.',
        };
        return;
      }

      // F14.15: record what the fidelity critic concluded against the version it describes.
      // Best-effort — a provenance write must never fail a completed re-ingest.
      if (fidelity) {
        void recordAiRun({
          subjectKind: 'version',
          subjectId: vid,
          versionId: vid,
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
          mode: 'stream',
        },
        clientIp,
      });

      log.info('Questionnaire re-ingested (stream)', {
        adminId,
        questionnaireId: id,
        versionId: vid,
        sectionCount: result.sectionCount,
        questionCount: result.questionCount,
        changeCount: result.changeCount,
      });

      yield {
        type: 'done',
        questionnaireId: id,
        versionId: vid,
        sectionCount: result.sectionCount,
        questionCount: result.questionCount,
        changeCount: result.changeCount,
        deduped: false,
      };
    }

    return sseResponse(drive(), { signal: request.signal });
  }
);

export const POST = handleReingestStream;
