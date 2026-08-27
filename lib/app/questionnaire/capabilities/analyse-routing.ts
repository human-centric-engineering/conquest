/**
 * Routing Analyst capability — Conditional Topics (P17.4).
 *
 * A `BaseCapability` that runs ONE structured LLM call over an uploaded instrument and returns the
 * TOPIC SET it implies: which groups of questions always run, which are conditional, the author's
 * own criteria for each conditional one, and any hard rules the document states as certainties.
 *
 * It is a PROPOSER, not an author: it writes nothing, changes no question, and everything it
 * returns lands in `AppQuestionnaireTopicDraft` for an admin to review — the same not-live contract
 * as the data-slot draft and the glossary's `proposed` terms.
 *
 * Modelled on `analyse-glossary-terms.ts`: provider-agnostic `runStructuredCompletion` (call →
 * parse → retry-once-at-temp-0 → cost-sum), the agent's binding read from the dispatch context
 * (`entityContext.routingAnalystAgent`), the `reasoning` tier.
 *
 * It sees the questionnaire's prompts and the full uploaded document, either of which may carry
 * examples or PII, so `processesPii = true` with a redacted provenance form. Boundary: lives under
 * `lib/app/**` — no Prisma, no Next.js.
 */

import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { z } from 'zod';

import { redactedString } from '@/lib/security/redact';
import { SOURCE_DOCUMENT_ROLES } from '@/lib/app/questionnaire/constants';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type { CapabilityContext, CapabilityResult } from '@/lib/orchestration/capabilities/types';
import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { isWorkflowAgentId } from '@/lib/orchestration/capabilities/dispatcher';
import {
  runStructuredCompletion,
  type StructuredCompletionResult,
} from '@/lib/orchestration/llm/structured-completion';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';

import { ANALYSE_ROUTING_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import {
  validateRoutingAnalysis,
  type RoutingAnalysisResult,
} from '@/lib/app/questionnaire/scope/analysis-schema';
import {
  buildRoutingAnalysisPrompt,
  buildRoutingAnalysisRetryMessage,
} from '@/lib/app/questionnaire/scope/analysis-prompt';
import {
  TOPIC_DEPTHS,
  TOPIC_PHASES,
  TOPIC_SOURCES,
  type Topic,
} from '@/lib/app/questionnaire/scope/types';

const SLUG = ANALYSE_ROUTING_FUNCTION_DEFINITION.name;

/**
 * Up to 40 topics, each with criteria, a rationale and a quoted span, plus rules — and a truncated
 * response fails validation outright rather than degrading, so the cap is generous relative to the
 * realistic output.
 */
const ROUTING_ANALYSIS_MAX_TOKENS = 12_288;

/**
 * One analysis call. Longer than the glossary's 90s because the input is bigger: this analyst reads
 * the WHOLE source document, the author's guidance included, where the glossary analyst reads the
 * questions plus a (usually short) definitions file. No respondent is waiting — an admin clicked a
 * button and is watching a progress stream, so patience is cheap here in a way it never is in the
 * planner's 12-second budget.
 */
const ROUTING_ANALYSIS_TIMEOUT_MS = 180_000;

const questionViewSchema = z.object({
  key: z.string().min(1),
  prompt: z.string().min(1),
  sectionTitle: z.string().optional(),
});

const dataSlotViewSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  theme: z.string().optional(),
});

/** Existing topics arrive as full `Topic` rows from the route; validate only what the prompt reads. */
const existingTopicSchema = z.object({
  id: z.string().optional(),
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullish(),
  phase: z.enum(TOPIC_PHASES),
  criteria: z.string().nullish(),
  depth: z.enum(TOPIC_DEPTHS),
  members: z.unknown().optional(),
  ordinal: z.number().optional(),
  source: z.enum(TOPIC_SOURCES),
});

/** One document the analyst reads — the instrument, or a companion attached beside it. */
const documentSchema = z.object({
  role: z.enum(SOURCE_DOCUMENT_ROLES),
  fileName: z.string().optional(),
  text: z.string(),
  truncated: z.boolean().optional(),
  omitted: z.boolean().optional(),
});

const argsSchema = z.object({
  questions: z.array(questionViewSchema).min(1),
  goal: z.string().nullish(),
  audience: z.unknown().optional(),
  dataSlots: z.array(dataSlotViewSchema).optional(),
  documents: z.array(documentSchema).optional(),
  existingTopics: z.array(existingTopicSchema).optional(),
  instructions: z.string().optional(),
  versionId: z.string().optional(),
});

export type AnalyseRoutingArgs = z.infer<typeof argsSchema>;

/**
 * What the capability returns: the analyst's proposal, plus the binding that actually served it.
 * Nothing is persisted here.
 *
 * See {@link DetectScopeCandidacyData} for why the binding travels with the result — the analyst
 * agent likewise ships with an empty `model`, so the caller cannot learn it from the agent row.
 */
export interface AnalyseRoutingData {
  result: RoutingAnalysisResult;
  /** Resolved provider slug, post-fallback — what actually answered. */
  provider: string;
  /** Resolved model id, post-fallback. */
  model: string;
  /** USD billed across both attempts, so the provenance row can price itself. */
  costUsd: number;
}

/** Read the dispatched analyst agent's binding from the dispatch context (empty → system default). */
function readAnalystAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.routingAnalystAgent;
  if (isRecord(raw)) {
    return {
      provider: typeof raw.provider === 'string' ? raw.provider : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      fallbackProviders: Array.isArray(raw.fallbackProviders)
        ? raw.fallbackProviders.filter((value): value is string => typeof value === 'string')
        : [],
    };
  }
  return { provider: '', model: '', fallbackProviders: [] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AppAnalyseRoutingCapability extends BaseCapability<
  AnalyseRoutingArgs,
  AnalyseRoutingData
> {
  readonly slug = SLUG;
  readonly processesPii = true;
  readonly functionDefinition = ANALYSE_ROUTING_FUNCTION_DEFINITION;
  protected readonly schema = argsSchema;

  /**
   * Args carry the questionnaire's prompts and the whole uploaded document, and the result quotes
   * spans from both. Persist a safe audit form — counts and the file name only, never a prompt, a
   * document, a criterion, or a quote.
   */
  redactProvenance(
    args: AnalyseRoutingArgs,
    result: CapabilityResult<AnalyseRoutingData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      questionCount: args.questions.length,
      dataSlotCount: args.dataSlots?.length ?? 0,
      existingTopicCount: args.existingTopics?.length ?? 0,
      // Document TEXT is the instrument itself — never in provenance. The shape of the set is,
      // because "which documents did this run actually read" is the first question asked of a
      // proposal that missed something.
      ...(args.documents !== undefined
        ? {
            documents: args.documents.map((document) => ({
              role: document.role,
              ...(document.fileName !== undefined ? { fileName: document.fileName } : {}),
              ...(document.truncated ? { truncated: true } : {}),
              ...(document.omitted ? { omitted: true } : {}),
              text: redactedString('text'),
            })),
          }
        : {}),
      ...(args.instructions !== undefined ? { instructions: redactedString('instructions') } : {}),
    };
    const preview =
      result.success && result.data
        ? JSON.stringify({
            success: true,
            data: {
              topicCount: result.data.result.topics.length,
              conditionalCount: result.data.result.topics.filter((t) => t.phase === 'conditional')
                .length,
              ruleCount: result.data.result.rules.length,
              gapCount: result.data.result.gaps.length,
              fromDocument: result.data.result.fromDocument,
            },
          })
        : JSON.stringify(result);
    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: AnalyseRoutingArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<AnalyseRoutingData>> {
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readAnalystAgentBinding(context.entityContext),
        'reasoning'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('analyse_routing: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('analyse_routing: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages = buildRoutingAnalysisPrompt({
      questions: args.questions,
      ...(args.goal !== undefined ? { goal: args.goal } : {}),
      ...(args.audience !== undefined ? { audience: args.audience } : {}),
      ...(args.dataSlots ? { dataSlots: args.dataSlots } : {}),
      ...(args.documents ? { documents: args.documents } : {}),
      ...(args.existingTopics ? { existingTopics: args.existingTopics as Topic[] } : {}),
      ...(args.instructions ? { instructions: args.instructions } : {}),
    });

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<RoutingAnalysisResult>;
    try {
      completion = await runStructuredCompletion<RoutingAnalysisResult>({
        provider,
        model,
        messages,
        maxTokens: ROUTING_ANALYSIS_MAX_TOKENS,
        timeoutMs: ROUTING_ANALYSIS_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateRoutingAnalysis(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildRoutingAnalysisRetryMessage(),
        onFinalFailure: () =>
          new Error(
            'Routing analyst response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('analyse_routing: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'routing_analysis_failed');
    }

    void logCost({
      // A workflow step dispatches with `workflow:<id>` in `agentId`, which is not
      // an AiAgent row — the FK violation is caught inside logCost and the cost row
      // silently never exists (Sunrise #599/#600). Attribute only a real agent id.
      ...(context.agentId && !isWorkflowAgentId(context.agentId)
        ? { agentId: context.agentId }
        : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: {
        capability: SLUG,
        ...(args.versionId ? { versionId: args.versionId } : {}),
      },
    }).catch((err) => {
      logger.error('analyse_routing: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    return this.success({
      result: completion.value,
      provider: providerSlug,
      model,
      costUsd: completion.costUsd,
    });
  }
}
