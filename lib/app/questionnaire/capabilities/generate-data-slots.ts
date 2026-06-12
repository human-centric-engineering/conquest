/**
 * Data-slot generation capability — infers the semantic abstraction layer over a version's
 * questions (Data Slots feature). Modelled on F5.1's evaluate-structure: one provider-agnostic
 * structured LLM call via `runStructuredCompletion` (call → parse → retry-once-at-temp-0 →
 * cost-sum), validated against the data-slots output schema. Persists nothing — the route
 * returns the proposed slots for admin review.
 *
 * Input is the **authored structure** (goal, audience, question prompts) — admin content, not
 * respondent PII — so `processesPii = false`. Lives under `lib/app/**`: no Prisma, no Next.
 */

import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { CostOperation } from '@/types/orchestration';
import { z } from 'zod';

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

import { GENERATE_DATA_SLOTS_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import {
  buildDataSlotGenerationPrompt,
  buildDataSlotRetryMessage,
  dataSlotGranularitySchema,
  dataSlotStructureSchema,
  validateDataSlotGeneration,
  type DataSlotGenerationOutput,
} from '@/lib/app/questionnaire/data-slots';

const SLUG = GENERATE_DATA_SLOTS_FUNCTION_DEFINITION.name;

/**
 * Designing a slot set over a whole questionnaire, with the DETAILED per-slot
 * descriptions the interviewer relies on, is a sizable generation — give it room.
 * Too low and the JSON is truncated mid-array → parse fails → fail-soft empty set.
 */
const GENERATE_MAX_TOKENS = 8_192;
/** One call; a large question set + long descriptions can run well past a minute. */
const GENERATE_TIMEOUT_MS = 120_000;

const argsSchema = z.object({
  structure: dataSlotStructureSchema,
  versionId: z.string().optional(),
  // Optional: omitted → the prompt builder applies the default (balanced) level.
  granularity: dataSlotGranularitySchema.optional(),
});

export type GenerateDataSlotsArgs = z.infer<typeof argsSchema>;
export interface GenerateDataSlotsData {
  slots: DataSlotGenerationOutput['slots'];
}

function readGeneratorBinding(entityContext: CapabilityContext['entityContext']): ResolvableAgent {
  const raw = entityContext?.dataSlotsAgent;
  if (isRecord(raw)) {
    return {
      provider: typeof raw.provider === 'string' ? raw.provider : '',
      model: typeof raw.model === 'string' ? raw.model : '',
      fallbackProviders: Array.isArray(raw.fallbackProviders)
        ? raw.fallbackProviders.filter((v): v is string => typeof v === 'string')
        : [],
    };
  }
  return { provider: '', model: '', fallbackProviders: [] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a raw structured-completion failure into a specific diagnostic code + a
 * human, actionable message. The route forwards both to the admin so the surface
 * says *why* it failed (truncated output vs. timeout vs. bad shape) instead of a
 * generic "generation failed".
 */
export function classifyGenerationFailure(
  raw: string,
  issuePaths: string[]
): { code: string; message: string } {
  const lower = raw.toLowerCase();

  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('abort')) {
    return {
      code: 'generation_timeout',
      message:
        'The generator timed out. Large questionnaires with detailed descriptions can exceed the ' +
        'time limit — try a broader granularity (fewer, higher-level slots) and run it again.',
    };
  }

  // The retry-exhausted path: empty issuePaths means the JSON itself didn't parse (usually the
  // response was cut off mid-array); non-empty means it parsed but didn't match the schema.
  if (lower.includes('not valid against the schema')) {
    if (issuePaths.length === 0) {
      return {
        code: 'incomplete_response',
        message:
          'The model returned an incomplete or non-JSON response — it was likely cut off before ' +
          'finishing. Try a broader granularity so it produces fewer, shorter slots, then retry.',
      };
    }
    return {
      code: 'invalid_response',
      message: `The model's response didn't match the expected shape (issues at: ${issuePaths.join(
        ', '
      )}). Try again.`,
    };
  }

  return {
    code: 'generation_failed',
    message: raw || 'Data-slot generation failed unexpectedly. Try again.',
  };
}

export class AppGenerateDataSlotsCapability extends BaseCapability<
  GenerateDataSlotsArgs,
  GenerateDataSlotsData
> {
  readonly slug = SLUG;
  readonly processesPii = false;
  readonly functionDefinition = GENERATE_DATA_SLOTS_FUNCTION_DEFINITION;
  protected readonly schema = argsSchema;

  async execute(
    args: GenerateDataSlotsArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<GenerateDataSlotsData>> {
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readGeneratorBinding(context.entityContext),
        'reasoning'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('generate_data_slots: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('generate_data_slots: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages = buildDataSlotGenerationPrompt(args.structure, args.granularity);

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<DataSlotGenerationOutput>;
    try {
      completion = await runStructuredCompletion<DataSlotGenerationOutput>({
        provider,
        model,
        messages,
        maxTokens: GENERATE_MAX_TOKENS,
        timeoutMs: GENERATE_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateDataSlotGeneration(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((i) =>
              i.path.length > 0 ? i.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildDataSlotRetryMessage(),
        onFinalFailure: () =>
          new Error(
            'Data-slot generation response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('generate_data_slots: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      const classified = classifyGenerationFailure(errorMessage(err), lastIssuePaths);
      return this.error(classified.message, classified.code);
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
      logger.error('generate_data_slots: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    return this.success({ slots: completion.value.slots });
  }
}
