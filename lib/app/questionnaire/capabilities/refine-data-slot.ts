/**
 * Refine-a-single-data-slot capability (Data Slots feature). Sibling to
 * `AppGenerateDataSlotsCapability`: one provider-agnostic structured LLM call via
 * `runStructuredCompletion` (call → parse → retry-once-at-temp-0 → cost-sum), validated against
 * the single-slot refinement output schema. Reuses the same data-slot generator agent binding and
 * `reasoning` tier. Persists nothing — the route returns the one refined slot for the admin to
 * review and (eventually) save.
 *
 * Input is the **authored structure** + the slot + admin instructions — admin content, not
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

import { REFINE_DATA_SLOT_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import {
  buildDataSlotRefinementPrompt,
  buildDataSlotRefinementRetryMessage,
  classifyGenerationFailure,
  dataSlotStructureSchema,
  refineInputSlotSchema,
  validateDataSlotRefinement,
  type DataSlotRefinementOutput,
} from '@/lib/app/questionnaire/data-slots';

const SLUG = REFINE_DATA_SLOT_FUNCTION_DEFINITION.name;

/** Refining one slot (with its detailed description) is far smaller than a whole-set generation. */
const REFINE_MAX_TOKENS = 2_048;
/** One short call over a single slot — but the full question list is in context, so allow a minute. */
const REFINE_TIMEOUT_MS = 60_000;

const argsSchema = z.object({
  structure: dataSlotStructureSchema,
  slot: refineInputSlotSchema,
  instructions: z.string().trim().min(1).max(2000),
  /** Other slots' names/themes, so the model keeps the theme consistent and stays distinct. */
  siblingSlots: z
    .array(z.object({ name: z.string(), theme: z.string() }))
    .max(120)
    .optional(),
  versionId: z.string().optional(),
});

export type RefineDataSlotArgs = z.infer<typeof argsSchema>;
export interface RefineDataSlotData {
  slot: DataSlotRefinementOutput['slot'];
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

export class AppRefineDataSlotCapability extends BaseCapability<
  RefineDataSlotArgs,
  RefineDataSlotData
> {
  readonly slug = SLUG;
  readonly processesPii = false;
  readonly functionDefinition = REFINE_DATA_SLOT_FUNCTION_DEFINITION;
  protected readonly schema = argsSchema;

  async execute(
    args: RefineDataSlotArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<RefineDataSlotData>> {
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
      logger.error('refine_data_slot: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('refine_data_slot: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages = buildDataSlotRefinementPrompt(
      args.structure,
      args.slot,
      args.instructions,
      args.siblingSlots ?? []
    );

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<DataSlotRefinementOutput>;
    try {
      completion = await runStructuredCompletion<DataSlotRefinementOutput>({
        provider,
        model,
        messages,
        maxTokens: REFINE_MAX_TOKENS,
        timeoutMs: REFINE_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateDataSlotRefinement(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((i) =>
              i.path.length > 0 ? i.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildDataSlotRefinementRetryMessage(),
        onFinalFailure: () =>
          new Error(
            'Data-slot refinement response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('refine_data_slot: structured completion failed', {
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
      logger.error('refine_data_slot: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    return this.success({ slot: completion.value.slot });
  }
}
