/**
 * Question-repair capability — the scales/matrix specialist (ingest verify + repair).
 *
 * A `BaseCapability` that runs ONE structured LLM call over the FLAGGED subset of extracted
 * questions (plus any rating-grid spans the verifier found and the source) and returns
 * corrected questions. It persists nothing and applies nothing — the orchestrator's
 * `mergeRepairs` guard decides whether each correction is strictly better than the original.
 *
 * Modelled on `evaluate-structure` / `verify-extraction-structure`: provider-agnostic
 * `runStructuredCompletion`, binding from `entityContext.repairAgent`, the `reasoning` tier.
 * A larger token cap than the verifier (it emits whole questions, but only for the few
 * flagged). Sees the source document → `processesPii = true`. Boundary: `lib/app/**` only.
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

import { REPAIR_QUESTIONS_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import type { ExtractedQuestion } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import {
  validateRepairResult,
  type RepairResult,
} from '@/lib/app/questionnaire/ingestion/repair-schema';
import {
  buildRepairPrompt,
  buildRepairRetryMessage,
} from '@/lib/app/questionnaire/ingestion/repair-prompt';

const SLUG = REPAIR_QUESTIONS_FUNCTION_DEFINITION.name;

/** Emits whole questions, but only for the flagged few — a moderate cap. */
const REPAIR_MAX_TOKENS = 8_192;

/** One repair call; 90s covers a slow reasoning model re-reading a grid span. */
const REPAIR_TIMEOUT_MS = 90_000;

const argsSchema = z.object({
  /** The flagged questions to repair — full extracted objects (validated loosely; the prompt owns shape). */
  targets: z.array(z.record(z.string(), z.unknown())),
  matrixGroups: z
    .array(
      z.object({
        label: z.string(),
        sourceSpanQuote: z.string(),
        memberKeys: z.array(z.string()).default([]),
      })
    )
    .default([]),
  issueByKey: z.record(z.string(), z.string()).optional(),
  documentText: z.string(),
  fileName: z.string().optional(),
  versionId: z.string().optional(),
});

export type RepairQuestionsArgs = z.infer<typeof argsSchema>;

/** What the capability returns: the specialist's corrected questions, keyed to the originals. */
export interface RepairQuestionsData {
  result: RepairResult;
}

/** Read the dispatched repair agent's binding from the dispatch context (empty → system default). */
function readRepairAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.repairAgent;
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

export class AppRepairQuestionsCapability extends BaseCapability<
  RepairQuestionsArgs,
  RepairQuestionsData
> {
  readonly slug = SLUG;
  readonly processesPii = true;
  readonly functionDefinition = REPAIR_QUESTIONS_FUNCTION_DEFINITION;
  protected readonly schema = argsSchema;

  /**
   * Args carry the source document + flagged questions (PII); the result carries corrected
   * questions (prompts, source quotes) that can echo it. Persist a safe audit form: the file
   * name, target count, and repair count — never the document text or the questions themselves.
   */
  redactProvenance(
    args: RepairQuestionsArgs,
    result: CapabilityResult<RepairQuestionsData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      ...(args.fileName !== undefined ? { fileName: args.fileName } : {}),
      targetCount: args.targets.length,
      matrixGroupCount: args.matrixGroups.length,
      documentText: redactedString('documentText'),
    };
    const preview =
      result.success && result.data
        ? JSON.stringify({
            success: true,
            data: { repairCount: result.data.result.repairs.length },
          })
        : JSON.stringify(result);
    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: RepairQuestionsArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<RepairQuestionsData>> {
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readRepairAgentBinding(context.entityContext),
        'reasoning'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('repair_questions: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('repair_questions: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages = buildRepairPrompt({
      // The prompt renders these; the tight extracted shape is enforced on the OUTPUT, not the input.
      targets: args.targets as unknown as ExtractedQuestion[],
      matrixGroups: args.matrixGroups,
      ...(args.issueByKey ? { issueByKey: args.issueByKey } : {}),
      documentText: args.documentText,
      ...(args.fileName ? { fileName: args.fileName } : {}),
    });

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<RepairResult>;
    try {
      completion = await runStructuredCompletion<RepairResult>({
        provider,
        model,
        messages,
        maxTokens: REPAIR_MAX_TOKENS,
        timeoutMs: REPAIR_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateRepairResult(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildRepairRetryMessage(),
        onFinalFailure: () =>
          new Error(
            'Repair response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('repair_questions: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'repair_failed');
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
      logger.error('repair_questions: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    return this.success({ result: completion.value });
  }
}
