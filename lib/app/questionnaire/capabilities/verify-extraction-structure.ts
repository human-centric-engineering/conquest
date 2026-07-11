/**
 * Extraction-verifier capability (ingest verify + repair).
 *
 * A `BaseCapability` that runs ONE structured LLM call over all extracted questions +
 * the source document and returns per-question verdicts (ok / suspect) plus any rating-grid
 * spans it detects. It is a CRITIC — it flags, it never rewrites; the orchestrator decides
 * which flagged questions to send to the repair specialist.
 *
 * Modelled on F5.1's `evaluate-structure`: provider-agnostic
 * `runStructuredCompletion` (call → parse → retry-once-at-temp-0 → cost-sum), the judge
 * agent's binding read from the dispatch context (`entityContext.verifierAgent`), the
 * `reasoning` tier. Small output (flags, not rewrites) → a modest token cap.
 *
 * It sees the source document text (which may contain examples/PII), so `processesPii = true`
 * like the extractor. Boundary: lives under `lib/app/**` — no Prisma, no Next.js.
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
  tryParseJson,
  type StructuredCompletionResult,
} from '@/lib/orchestration/evaluations/parse-structured';

import { VERIFY_EXTRACTION_STRUCTURE_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import {
  validateVerifyResult,
  type VerifyResult,
} from '@/lib/app/questionnaire/ingestion/verify-schema';
import {
  buildVerifyPrompt,
  buildVerifyRetryMessage,
} from '@/lib/app/questionnaire/ingestion/verify-prompt';

const SLUG = VERIFY_EXTRACTION_STRUCTURE_FUNCTION_DEFINITION.name;

/** Flags-only output stays small even for a long questionnaire. */
const VERIFY_MAX_TOKENS = 4_096;

/** One verify call; 60s covers a slow reasoning model over a long document. */
const VERIFY_TIMEOUT_MS = 60_000;

const questionViewSchema = z.object({
  key: z.string().min(1),
  prompt: z.string(),
  suggestedType: z.string(),
  suggestedTypeConfig: z.unknown().optional(),
  sourceQuote: z.string().optional(),
  extractionConfidence: z.number().optional(),
});

const argsSchema = z.object({
  questions: z.array(questionViewSchema),
  documentText: z.string(),
  fileName: z.string().optional(),
  versionId: z.string().optional(),
});

export type VerifyExtractionStructureArgs = z.infer<typeof argsSchema>;

/** What the capability returns: the verifier's verdicts + detected grid spans. */
export interface VerifyExtractionStructureData {
  result: VerifyResult;
}

/** Read the dispatched verifier agent's binding from the dispatch context (empty → system default). */
function readVerifierAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.verifierAgent;
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

export class AppVerifyExtractionStructureCapability extends BaseCapability<
  VerifyExtractionStructureArgs,
  VerifyExtractionStructureData
> {
  readonly slug = SLUG;
  readonly processesPii = true;
  readonly functionDefinition = VERIFY_EXTRACTION_STRUCTURE_FUNCTION_DEFINITION;
  protected readonly schema = argsSchema;

  /**
   * Args carry the source document text + extracted prompts (PII); the result carries only
   * per-question verdicts + grid spans (which can echo it). Persist a safe audit form: the file
   * name, question count, and verdict counts — never the document text or the grid span quotes.
   */
  redactProvenance(
    args: VerifyExtractionStructureArgs,
    result: CapabilityResult<VerifyExtractionStructureData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      ...(args.fileName !== undefined ? { fileName: args.fileName } : {}),
      questionCount: args.questions.length,
      documentText: redactedString('documentText'),
    };
    const preview =
      result.success && result.data
        ? JSON.stringify({
            success: true,
            data: {
              verdictCount: result.data.result.verdicts.length,
              suspectCount: result.data.result.verdicts.filter((v) => v.verdict === 'suspect')
                .length,
              matrixGroupCount: result.data.result.matrixGroups.length,
            },
          })
        : JSON.stringify(result);
    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: VerifyExtractionStructureArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<VerifyExtractionStructureData>> {
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readVerifierAgentBinding(context.entityContext),
        'reasoning'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('verify_extraction: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('verify_extraction: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages = buildVerifyPrompt({
      questions: args.questions,
      documentText: args.documentText,
      ...(args.fileName ? { fileName: args.fileName } : {}),
    });

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<VerifyResult>;
    try {
      completion = await runStructuredCompletion<VerifyResult>({
        provider,
        model,
        messages,
        maxTokens: VERIFY_MAX_TOKENS,
        timeoutMs: VERIFY_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateVerifyResult(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildVerifyRetryMessage(),
        onFinalFailure: () =>
          new Error(
            'Verifier response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('verify_extraction: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'verification_failed');
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
      logger.error('verify_extraction: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    return this.success({ result: completion.value });
  }
}
