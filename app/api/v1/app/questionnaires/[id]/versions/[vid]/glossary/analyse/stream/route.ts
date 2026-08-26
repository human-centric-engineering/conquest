/**
 * Streaming glossary analysis — definitions / glossary (P16).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/glossary/analyse/stream
 *   Admin-only SSE endpoint. Runs the Glossary Analyst over the version's questions (and the
 *   attached definitions document, when there is one) and persists the result as the version's
 *   `proposed` terms, emitting `reading` → `analysing` → `saving` → `done` so the admin watches
 *   progress instead of a spinner. Per-admin sub-cap.
 *
 * **This route does not fork a launched version.** A proposal is inert — nothing reads `proposed`
 * terms but the review queue — so writing one to a launched version changes nothing a respondent
 * or the runtime can see. Only the reviewed save (`PUT …/glossary`) forks. That is the same rule
 * the data-slot draft follows, and it is what keeps this endpoint a simple write.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { sseResponse } from '@/lib/api/sse';
import { withAdminAuth } from '@/lib/auth/guards';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import {
  ANALYSE_GLOSSARY_TERMS_CAPABILITY_SLUG,
  QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { GlossaryAnalysisEvent } from '@/lib/app/questionnaire/glossary/analysis-events';
import {
  validateGlossaryAnalysis,
  type GlossaryAnalysisResult,
} from '@/lib/app/questionnaire/glossary/analysis-schema';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import {
  normaliseBinding,
  readResolvedBinding,
} from '@/lib/app/questionnaire/ai-run/resolved-binding';
import {
  buildGlossaryAnalysisInput,
  loadGlossaryTerms,
  persistProposedTerms,
} from '@/app/api/v1/app/questionnaires/_lib/glossary-routes';
import { glossaryAnalysisLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

const handleAnalyseStream = withAdminAuth<{ id: string; vid: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const clientIp = getClientIP(request);
    const { id, vid } = await params;
    const adminId = session.user.id;

    const rl = glossaryAnalysisLimiter.check(adminId);
    if (!rl.success) {
      log.warn('Glossary analysis rate limit exceeded', { adminId, reset: rl.reset });
      return createRateLimitResponse(rl);
    }

    const input = await buildGlossaryAnalysisInput(id, vid);
    if (!input) {
      throw new NotFoundError('Questionnaire version not found or has no questions');
    }

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      log.error('Glossary Analyst agent not found; run db:seed', {
        slug: QUESTIONNAIRE_GLOSSARY_ANALYST_AGENT_SLUG,
      });
      throw new NotFoundError('Glossary analysis is not configured');
    }

    /**
     * Drive the run. A failure after the first event is streamed as `error` rather than thrown —
     * the response is already open, so it cannot become a 5xx.
     */
    async function* drive(): AsyncGenerator<GlossaryAnalysisEvent> {
      const startedAt = Date.now();

      yield {
        type: 'phase',
        phase: 'reading',
        message: input!.documentText
          ? `Reading ${input!.questions.length} questions and your definitions document…`
          : `Reading ${input!.questions.length} questions…`,
      };

      yield {
        type: 'phase',
        phase: 'analysing',
        message: 'Looking for terms that are open to interpretation…',
      };

      registerBuiltInCapabilities();
      const dispatch = await capabilityDispatcher.dispatch(
        ANALYSE_GLOSSARY_TERMS_CAPABILITY_SLUG,
        {
          questions: input!.questions,
          goal: input!.goal,
          audience: input!.audience,
          dataSlotNames: input!.dataSlotNames,
          ...(input!.documentText ? { documentText: input!.documentText } : {}),
          ...(input!.documentFileName ? { documentFileName: input!.documentFileName } : {}),
          existingTerms: input!.existingTerms,
          versionId: vid,
        },
        {
          userId: adminId,
          agentId: agent!.id,
          entityContext: {
            glossaryAnalystAgent: {
              provider: agent!.provider,
              model: agent!.model,
              fallbackProviders: agent!.fallbackProviders,
            },
          },
        }
      );

      if (!dispatch.success) {
        const code = dispatch.error?.code ?? 'GLOSSARY_ANALYSIS_FAILED';
        const message = dispatch.error?.message ?? 'The glossary analysis could not be completed.';
        log.error('Glossary analysis dispatch failed', { versionId: vid, code, message });
        void recordAiRun({
          subjectKind: 'version',
          subjectId: vid,
          versionId: vid,
          kind: 'glossary_analysis',
          status: 'failed',
          // The sentinel is right here: the dispatch failed, so there may be no model that ever
          // answered. Do not "fix" this to match the success path below.
          ...normaliseBinding(agent!.provider, agent!.model),
          durationMs: Date.now() - startedAt,
          error: message,
          triggeredByUserId: adminId,
        });
        yield { type: 'error', code, message };
        return;
      }

      // The dispatcher's payload is typed `unknown` at this seam — re-validate rather than assert,
      // so a capability that ever changed shape fails here instead of writing malformed rows.
      const parsed = validateGlossaryAnalysis(
        (dispatch.data as { result?: unknown } | undefined)?.result
      );
      if (!parsed.ok) {
        log.error('Glossary analysis returned an unexpected shape', {
          versionId: vid,
          issues: parsed.issues.map((issue) => issue.path.join('.')),
        });
        yield {
          type: 'error',
          code: 'GLOSSARY_ANALYSIS_INVALID',
          message: 'The glossary analysis returned an unexpected result. Please try again.',
        };
        return;
      }
      const result: GlossaryAnalysisResult = parsed.value;

      yield {
        type: 'phase',
        phase: 'saving',
        message:
          result.terms.length === 0
            ? 'No terms needed defining — finishing up…'
            : `Saving ${result.terms.length} suggested ${result.terms.length === 1 ? 'term' : 'terms'}…`,
      };

      const persisted = await persistProposedTerms(vid, result.terms, adminId);

      void recordAiRun({
        subjectKind: 'version',
        subjectId: vid,
        versionId: vid,
        kind: 'glossary_analysis',
        status: 'succeeded',
        // Read off the dispatch, not the agent row — this agent's configured model is empty by
        // design, so the row used to record a placeholder for a call that really ran on a model.
        ...readResolvedBinding(dispatch.data),
        outputSnapshot: result,
        durationMs: Date.now() - startedAt,
        detail: {
          proposedCount: persisted.proposedCount,
          skippedExistingCount: persisted.skippedExistingCount,
          questionCount: input!.questions.length,
          usedDocument: Boolean(input!.documentText),
        },
        triggeredByUserId: adminId,
      });

      logAdminAction({
        userId: adminId,
        action: 'questionnaire_glossary.analyse',
        entityType: 'questionnaire_version',
        entityId: vid,
        metadata: {
          questionnaireId: id,
          versionId: vid,
          proposedCount: persisted.proposedCount,
          skippedExistingCount: persisted.skippedExistingCount,
        },
        clientIp,
      });
      log.info('Glossary analysed', {
        questionnaireId: id,
        versionId: vid,
        proposedCount: persisted.proposedCount,
        skippedExistingCount: persisted.skippedExistingCount,
      });

      // Return the FULL curated set, not just counts: the editor's working state lives in
      // `useState` (whose initialiser never re-runs) and `router.refresh()` preserves client
      // state, so a counts-only event would leave the review queue visibly empty after a
      // successful run.
      const terms = await loadGlossaryTerms(vid);

      yield {
        type: 'done',
        versionId: vid,
        terms,
        proposedCount: persisted.proposedCount,
        skippedExistingCount: persisted.skippedExistingCount,
        acceptedCount: persisted.acceptedCount,
      };
    }

    return sseResponse(drive(), { signal: request.signal });
  }
);

export const POST = handleAnalyseStream;
