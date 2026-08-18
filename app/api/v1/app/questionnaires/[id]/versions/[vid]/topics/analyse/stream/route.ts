/**
 * Streaming routing analysis — the Routing Analyst (Adaptive Scope, P17.4).
 *
 * POST /api/v1/app/questionnaires/:id/versions/:vid/topics/analyse/stream
 *   Admin-only SSE endpoint. Runs the Routing Analyst over the version's questions AND its uploaded
 *   source document — the instruction pages structure extraction throws away — and persists the
 *   result as the version's pending `AppQuestionnaireTopicDraft`, emitting `reading` → `analysing`
 *   → `saving` → `done` so the admin watches progress instead of a spinner. Per-admin sub-cap.
 *
 * **This route does not fork a launched version.** A proposal is inert — nothing but the review
 * surface reads the draft table — so writing one to a launched version changes nothing a respondent
 * or the runtime can see. Only the accept (`POST …/topics/draft`) forks. That is the same rule the
 * glossary analysis and the data-slot draft follow, and it is what keeps this endpoint a simple
 * write.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { sseResponse } from '@/lib/api/sse';
import { withAdminAuth } from '@/lib/auth/guards';
import { validateRequestBody } from '@/lib/api/validation';
import { createRateLimitResponse } from '@/lib/security/rate-limit';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getClientIP } from '@/lib/security/ip';

import { prisma } from '@/lib/db/client';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';

import {
  ANALYSE_ROUTING_CAPABILITY_SLUG,
  QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
} from '@/lib/app/questionnaire/constants';
import type { RoutingAnalysisEvent } from '@/lib/app/questionnaire/scope/analysis-events';
import {
  validateRoutingAnalysis,
  type RoutingAnalysisResult,
} from '@/lib/app/questionnaire/scope/analysis-schema';
import { runRoutingAnalysisSchema } from '@/lib/app/questionnaire/scope/schemas';
import type { ProposedTopicSet } from '@/lib/app/questionnaire/scope/types';
import { recordAiRun } from '@/lib/app/questionnaire/ai-run/store';
import {
  buildRoutingAnalysisInput,
  saveTopicDraft,
} from '@/app/api/v1/app/questionnaires/_lib/topic-draft';
import { routingAnalysisLimiter } from '@/app/api/v1/app/questionnaires/_lib/rate-limit';

/**
 * Project the analyst's validated result onto the stored {@link ProposedTopicSet}.
 *
 * `replacesExisting` is stamped here, not asked of the model: whether a proposed key collides with
 * a live topic is a fact about the database, and a model asked to self-report it would sometimes be
 * wrong about the one thing the review surface uses to say "this replaces what you have".
 */
function toProposedSet(
  result: RoutingAnalysisResult,
  existingKeys: ReadonlySet<string>,
  generatedAt: string
): ProposedTopicSet {
  return {
    v: 1,
    topics: result.topics.map((topic) => ({
      key: topic.key,
      label: topic.label,
      phase: topic.phase,
      criteria: topic.criteria,
      depth: topic.depth,
      members: { questionKeys: topic.questionKeys, dataSlotKeys: topic.dataSlotKeys },
      rationale: topic.rationale,
      ...(topic.sourceQuote ? { sourceQuote: topic.sourceQuote } : {}),
      ...(existingKeys.has(topic.key) ? { replacesExisting: true } : {}),
    })),
    rules: result.rules.map((rule) => ({
      dataSlotKey: rule.dataSlotKey,
      operator: rule.operator,
      value: rule.value,
      action: rule.action,
      topicKey: rule.topicKey,
      rationale: rule.rationale,
      ...(rule.sourceQuote ? { sourceQuote: rule.sourceQuote } : {}),
    })),
    gaps: result.gaps.map((gap) => ({
      sourceQuote: gap.sourceQuote,
      explanation: gap.explanation,
    })),
    ...(result.maxConditionalTopics !== undefined
      ? { maxConditionalTopics: result.maxConditionalTopics }
      : {}),
    summary: result.summary,
    fromDocument: result.fromDocument,
    generatedAt,
  };
}

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

    const agent = await prisma.aiAgent.findUnique({
      where: { slug: QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG },
      select: { id: true, provider: true, model: true, fallbackProviders: true },
    });
    if (!agent) {
      log.error('Routing Analyst agent not found; run db:seed', {
        slug: QUESTIONNAIRE_ROUTING_ANALYST_AGENT_SLUG,
      });
      throw new NotFoundError('Routing analysis is not configured');
    }

    /**
     * Drive the run. A failure after the first event is streamed as `error` rather than thrown —
     * the response is already open, so it cannot become a 5xx.
     */
    async function* drive(): AsyncGenerator<RoutingAnalysisEvent> {
      const startedAt = Date.now();

      yield {
        type: 'phase',
        phase: 'reading',
        message: input!.documentText
          ? `Reading ${input!.questions.length} questions and your uploaded document…`
          : `Reading ${input!.questions.length} questions — no source document is attached…`,
      };

      yield {
        type: 'phase',
        phase: 'analysing',
        message: 'Working out which parts apply to whom…',
      };

      registerBuiltInCapabilities();
      const dispatch = await capabilityDispatcher.dispatch(
        ANALYSE_ROUTING_CAPABILITY_SLUG,
        {
          questions: input!.questions,
          goal: input!.goal,
          ...(input!.audience !== undefined ? { audience: input!.audience } : {}),
          dataSlots: input!.dataSlots,
          ...(input!.documentText ? { documentText: input!.documentText } : {}),
          ...(input!.documentFileName ? { documentFileName: input!.documentFileName } : {}),
          existingTopics: input!.existingTopics,
          ...(body.instructions ? { instructions: body.instructions } : {}),
          versionId: vid,
        },
        {
          userId: adminId,
          agentId: agent!.id,
          entityContext: {
            routingAnalystAgent: {
              provider: agent!.provider,
              model: agent!.model,
              fallbackProviders: agent!.fallbackProviders,
            },
          },
        }
      );

      if (!dispatch.success) {
        const code = dispatch.error?.code ?? 'ROUTING_ANALYSIS_FAILED';
        const message = dispatch.error?.message ?? 'The routing analysis could not be completed.';
        log.error('Routing analysis dispatch failed', { versionId: vid, code, message });
        void recordAiRun({
          subjectKind: 'version',
          subjectId: vid,
          versionId: vid,
          kind: 'routing_analysis',
          status: 'failed',
          provider: agent!.provider || 'resolved-at-runtime',
          model: agent!.model || 'resolved-at-runtime',
          durationMs: Date.now() - startedAt,
          error: message,
          triggeredByUserId: adminId,
        });
        yield { type: 'error', code, message };
        return;
      }

      // The dispatcher's payload is typed `unknown` at this seam — re-validate rather than assert,
      // so a capability that ever changed shape fails here instead of writing a malformed draft.
      const parsed = validateRoutingAnalysis(
        (dispatch.data as { result?: unknown } | undefined)?.result
      );
      if (!parsed.ok) {
        log.error('Routing analysis returned an unexpected shape', {
          versionId: vid,
          issues: parsed.issues.map((issue) => issue.path.join('.')),
        });
        yield {
          type: 'error',
          code: 'ROUTING_ANALYSIS_INVALID',
          message: 'The routing analysis returned an unexpected result. Please try again.',
        };
        return;
      }
      const result: RoutingAnalysisResult = parsed.value;

      yield {
        type: 'phase',
        phase: 'saving',
        message:
          result.topics.length === 0
            ? 'Nothing routable found — finishing up…'
            : `Saving ${result.topics.length} proposed ${result.topics.length === 1 ? 'topic' : 'topics'}…`,
      };

      const existingKeys = new Set(input!.existingTopics.map((t) => t.key));
      const draft = await saveTopicDraft(
        vid,
        toProposedSet(result, existingKeys, new Date().toISOString())
      );

      // Which questions the proposal left homeless. Computed here rather than trusted from the
      // model: with scope active a question in no topic can never be asked, and nothing else in
      // the system reports it — so the reviewer is told the number before they accept, not after.
      const covered = new Set(draft.topics.flatMap((t) => t.members.questionKeys));
      const uncoveredQuestionCount = input!.questions.filter((q) => !covered.has(q.key)).length;
      const replacedCount = draft.topics.filter((t) => t.replacesExisting).length;

      void recordAiRun({
        subjectKind: 'version',
        subjectId: vid,
        versionId: vid,
        kind: 'routing_analysis',
        status: 'succeeded',
        provider: agent!.provider || 'resolved-at-runtime',
        model: agent!.model || 'resolved-at-runtime',
        outputSnapshot: result,
        durationMs: Date.now() - startedAt,
        detail: {
          topicCount: draft.topics.length,
          conditionalCount: draft.topics.filter((t) => t.phase === 'conditional').length,
          ruleCount: draft.rules.length,
          gapCount: draft.gaps.length,
          replacedCount,
          uncoveredQuestionCount,
          fromDocument: draft.fromDocument,
          usedDocument: Boolean(input!.documentText),
        },
        triggeredByUserId: adminId,
      });

      logAdminAction({
        userId: adminId,
        action: 'questionnaire_topics.analyse',
        entityType: 'questionnaire_version',
        entityId: vid,
        metadata: {
          questionnaireId: id,
          versionId: vid,
          topicCount: draft.topics.length,
          ruleCount: draft.rules.length,
          gapCount: draft.gaps.length,
          fromDocument: draft.fromDocument,
        },
        clientIp,
      });
      log.info('Routing analysed', {
        questionnaireId: id,
        versionId: vid,
        topicCount: draft.topics.length,
        ruleCount: draft.rules.length,
        gapCount: draft.gaps.length,
        fromDocument: draft.fromDocument,
        uncoveredQuestionCount,
      });

      yield { type: 'done', versionId: vid, draft, replacedCount, uncoveredQuestionCount };
    }

    return sseResponse(drive(), { signal: request.signal });
  }
);

export const POST = handleAnalyseStream;
