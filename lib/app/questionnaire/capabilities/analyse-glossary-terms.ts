/**
 * Glossary Analyst capability — definitions / glossary (P16).
 *
 * A `BaseCapability` that runs ONE structured LLM call over the questionnaire (plus the admin's
 * authoritative definitions document when one is attached) and returns candidate TERMS with
 * candidate DEFINITIONS. It is a PROPOSER, not an author: it writes nothing, changes no question,
 * and everything it returns lands as `proposed` for an admin to adjudicate.
 *
 * Modelled on `verify-extraction-structure.ts`: provider-agnostic `runStructuredCompletion`
 * (call → parse → retry-once-at-temp-0 → cost-sum), the agent's binding read from the dispatch
 * context (`entityContext.glossaryAnalystAgent`), the `reasoning` tier.
 *
 * It sees the questionnaire's prompts and an admin-supplied document, either of which may contain
 * examples or PII, so `processesPii = true` with a redacted provenance form. Boundary: lives under
 * `lib/app/**` — no Prisma, no Next.js.
 */

import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { z } from 'zod';

import { redactedString } from '@/lib/security/redact';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type { CapabilityContext, CapabilityResult } from '@/lib/orchestration/capabilities/types';
import {
  resolveAgentProviderAndModel,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import {
  runStructuredCompletion,
  type StructuredCompletionResult,
} from '@/lib/orchestration/llm/structured-completion';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';

import { ANALYSE_GLOSSARY_TERMS_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import {
  validateGlossaryAnalysis,
  type GlossaryAnalysisResult,
} from '@/lib/app/questionnaire/glossary/analysis-schema';
import {
  buildGlossaryAnalysisPrompt,
  buildGlossaryAnalysisRetryMessage,
} from '@/lib/app/questionnaire/glossary/analysis-prompt';

const SLUG = ANALYSE_GLOSSARY_TERMS_FUNCTION_DEFINITION.name;

/**
 * Proposals are short prose, but up to 40 terms × 4 definitions plus a rationale each adds up —
 * and a truncated response fails validation outright rather than degrading, so the cap is
 * generous relative to the realistic output.
 */
const GLOSSARY_ANALYSIS_MAX_TOKENS = 8_192;

/** One analysis call; 90s covers a reasoning model over a long instrument plus a document. */
const GLOSSARY_ANALYSIS_TIMEOUT_MS = 90_000;

const questionViewSchema = z.object({
  key: z.string().min(1),
  prompt: z.string().min(1),
  guidelines: z.string().optional(),
  sectionTitle: z.string().optional(),
});

const argsSchema = z.object({
  questions: z.array(questionViewSchema).min(1),
  goal: z.string().nullish(),
  audience: z.unknown().optional(),
  dataSlotNames: z.array(z.string()).optional(),
  documentText: z.string().optional(),
  documentFileName: z.string().optional(),
  existingTerms: z.array(z.string()).optional(),
  versionId: z.string().optional(),
});

export type AnalyseGlossaryTermsArgs = z.infer<typeof argsSchema>;

/**
 * What the capability returns: the analyst's proposal, plus the binding that served the call.
 * Nothing is persisted here. The binding travels with the result because this agent resolves its
 * model at call time, so the route writing the provenance row cannot read it off the agent row.
 */
export interface AnalyseGlossaryTermsData {
  result: GlossaryAnalysisResult;
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
  const raw = entityContext?.glossaryAnalystAgent;
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

export class AppAnalyseGlossaryTermsCapability extends BaseCapability<
  AnalyseGlossaryTermsArgs,
  AnalyseGlossaryTermsData
> {
  readonly slug = SLUG;
  readonly processesPii = true;
  readonly functionDefinition = ANALYSE_GLOSSARY_TERMS_FUNCTION_DEFINITION;
  protected readonly schema = argsSchema;

  /**
   * Args carry the questionnaire's prompts and an admin-supplied document, and the result carries
   * quoted spans from both. Persist a safe audit form — counts and the file name only, never a
   * prompt, a document, or a quote.
   */
  redactProvenance(
    args: AnalyseGlossaryTermsArgs,
    result: CapabilityResult<AnalyseGlossaryTermsData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      questionCount: args.questions.length,
      ...(args.documentFileName !== undefined ? { documentFileName: args.documentFileName } : {}),
      ...(args.documentText !== undefined ? { documentText: redactedString('documentText') } : {}),
      existingTermCount: args.existingTerms?.length ?? 0,
    };
    const preview =
      result.success && result.data
        ? JSON.stringify({
            success: true,
            data: {
              termCount: result.data.result.terms.length,
              definitionCount: result.data.result.terms.reduce(
                (total, term) => total + term.definitions.length,
                0
              ),
            },
          })
        : JSON.stringify(result);
    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: AnalyseGlossaryTermsArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<AnalyseGlossaryTermsData>> {
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
      logger.error('analyse_glossary: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('analyse_glossary: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages = buildGlossaryAnalysisPrompt({
      questions: args.questions,
      ...(args.goal !== undefined ? { goal: args.goal } : {}),
      ...(args.audience !== undefined ? { audience: args.audience } : {}),
      ...(args.dataSlotNames ? { dataSlotNames: args.dataSlotNames } : {}),
      ...(args.documentText ? { documentText: args.documentText } : {}),
      ...(args.documentFileName ? { documentFileName: args.documentFileName } : {}),
      ...(args.existingTerms ? { existingTerms: args.existingTerms } : {}),
    });

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<GlossaryAnalysisResult>;
    try {
      completion = await runStructuredCompletion<GlossaryAnalysisResult>({
        provider,
        model,
        messages,
        maxTokens: GLOSSARY_ANALYSIS_MAX_TOKENS,
        timeoutMs: GLOSSARY_ANALYSIS_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateGlossaryAnalysis(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildGlossaryAnalysisRetryMessage(),
        onFinalFailure: () =>
          new Error(
            'Glossary analyst response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('analyse_glossary: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'glossary_analysis_failed');
    }

    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
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
      logger.error('analyse_glossary: logCost rejected', {
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
