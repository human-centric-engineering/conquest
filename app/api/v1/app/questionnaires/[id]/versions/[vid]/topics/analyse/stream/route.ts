/**
 * Streaming routing analysis — the Routing Analyst (Conditional Topics, P17.4).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/topics/analyse/stream
 *   Admin-only SSE endpoint. Runs the Routing Analyst over the version's questions AND its uploaded
 *   source document — the author's guidance structure extraction throws away — and persists the
 *   result as the version's pending `AppQuestionnaireTopicDraft`, emitting `reading` → `analysing`
 *   → `saving` → `done` so the admin watches progress instead of a spinner. Per-admin sub-cap.
 *
 * **This route does not fork a launched version.** A proposal is inert — nothing but the review
 * surface reads the draft table — so writing one to a launched version changes nothing a respondent
 * or the runtime can see. Only the accept (`POST …/topics/draft`) forks. That is the same rule the
 * glossary analysis and the data-slot draft follow, and it is what keeps this endpoint a simple
 * write.
 *
 * The run itself lives in `_lib/routing-analysis.ts` (F17.22 Phase 2), because the streaming ingest
 * routes now propose during an upload and must record the same `AppAiRun` bookkeeping this route
 * does — that run row is the "already tried" signal the Topics tab's auto-trigger reads. This route
 * owns the phase events and the SSE framing; it does not own the analysis.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { sseResponse } from '@/lib/api/sse';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

import type { RoutingAnalysisEvent } from '@/lib/app/questionnaire/scope/analysis-events';
import { runRoutingAnalysisSchema } from '@/lib/app/questionnaire/scope/schemas';
import {
  buildRoutingAnalysisInput,
  type RoutingAnalysisRouteInput,
} from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import {
  dispatchRoutingAnalysis,
  loadRoutingAnalystAgent,
  persistRoutingAnalysis,
} from '@/app/api/v1/app/questionnaires/_lib/routing-analysis';
import { routingAnalysisLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const handleAnalyseStream = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const rl = routingAnalysisLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Routing analysis rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const body = await validateRequestBody(request, runRoutingAnalysisSchema);

    const input = await buildRoutingAnalysisInput(id, vid);
    if (!input) {
      throw new NotFoundError('Questionnaire version not found or has no questions');
    }

    const agent = await loadRoutingAnalystAgent();
    if (!agent) {
      log.error('Routing Analyst agent not found; run db:seed');
      throw new NotFoundError('Routing analysis is not configured');
    }

    /**
     * Drive the run. A failure after the first event is streamed as `error` rather than thrown —
     * the response is already open, so it cannot become a 5xx.
     */
    /** What the admin watching the stream is told is being read, before anything is spent on it. */
    function readingMessage(loaded: RoutingAnalysisRouteInput): string {
      const questions = `${loaded.questions.length} questions`;
      const supporting = loaded.documents.filter((d) => d.role === 'supplementary').length;
      if (loaded.documents.length === 0) {
        return `Reading ${questions} — no source document is attached…`;
      }
      if (supporting === 0) return `Reading ${questions} and your uploaded document…`;
      const plural = supporting === 1 ? 'document' : 'documents';
      return `Reading ${questions}, your uploaded document and ${supporting} supporting ${plural}…`;
    }

    async function* drive(): AsyncGenerator<RoutingAnalysisEvent> {
      const startedAt = Date.now();

      yield {
        type: 'phase',
        phase: 'reading',
        message: readingMessage(input!),
      };

      yield {
        type: 'phase',
        phase: 'analysing',
        message: 'Working out which parts apply to whom…',
      };

      const outcome = await dispatchRoutingAnalysis({
        versionId: vid,
        adminId,
        agent: agent!,
        input: input!,
        ...(body.instructions ? { instructions: body.instructions } : {}),
        startedAt,
        log,
      });
      if (!outcome.ok) {
        yield { type: 'error', code: outcome.code, message: outcome.message };
        return;
      }
      const result = outcome.result;

      yield {
        type: 'phase',
        phase: 'saving',
        message:
          result.topics.length === 0
            ? 'Nothing routable found — finishing up…'
            : `Saving ${result.topics.length} proposed ${result.topics.length === 1 ? 'topic' : 'topics'}…`,
      };

      const { draft, replacedCount, uncoveredQuestionCount } = await persistRoutingAnalysis({
        questionnaireId: id,
        versionId: vid,
        adminId,
        clientIp,
        agent: agent!,
        input: input!,
        result,
        startedAt,
        log,
        trigger: 'admin',
      });

      yield { type: 'done', versionId: vid, draft, replacedCount, uncoveredQuestionCount };
    }

    return sseResponse(drive(), { signal: request.signal });
  }
);

export const POST = handleAnalyseStream;
