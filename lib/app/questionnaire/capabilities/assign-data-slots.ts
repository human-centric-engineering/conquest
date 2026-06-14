/**
 * Assign-orphaned-questions-to-data-slots capability (Data Slots feature). Sibling to
 * `AppGenerateDataSlotsCapability` / `AppRefineDataSlotCapability`: one provider-agnostic
 * structured LLM call via `runStructuredCompletion` (call → parse → retry-once-at-temp-0 →
 * cost-sum), validated against the assignment output schema. Reuses the same data-slot generator
 * agent binding and `reasoning` tier.
 *
 * A question added after the slots were generated is "orphaned" — covered by no slot. This places
 * each orphan into an existing slot (when it's the same data point) or a new one, returning only
 * *placements* — the route merges deterministically and persists, so the model never rewrites the
 * existing slots. Input is the **authored structure** + slots — admin content, not respondent PII —
 * so `processesPii = false`. Lives under `lib/app/**`: no Prisma, no Next.
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

import { ASSIGN_DATA_SLOTS_FUNCTION_DEFINITION } from '@/lib/app/questionnaire/constants';
import {
  assignExistingSlotSchema,
  buildDataSlotAssignmentPrompt,
  buildDataSlotAssignmentRetryMessage,
  classifyGenerationFailure,
  dataSlotStructureSchema,
  validateDataSlotAssignment,
  type DataSlotAssignmentOutput,
} from '@/lib/app/questionnaire/data-slots';

const SLUG = ASSIGN_DATA_SLOTS_FUNCTION_DEFINITION.name;

/** Placements are small (one decision per question); the full question + slot set is the bulk. */
const ASSIGN_MAX_TOKENS = 4_096;
/** One call over the slots + questions — allow a minute like the refine path. */
const ASSIGN_TIMEOUT_MS = 90_000;

const argsSchema = z.object({
  structure: dataSlotStructureSchema,
  existingSlots: z.array(assignExistingSlotSchema).max(120),
  orphanQuestionKeys: z.array(z.string().min(1)).min(1).max(60),
  versionId: z.string().optional(),
});

export type AssignDataSlotsArgs = z.infer<typeof argsSchema>;
export interface AssignDataSlotsData {
  placements: DataSlotAssignmentOutput['placements'];
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

export class AppAssignDataSlotsCapability extends BaseCapability<
  AssignDataSlotsArgs,
  AssignDataSlotsData
> {
  readonly slug = SLUG;
  readonly processesPii = false;
  readonly functionDefinition = ASSIGN_DATA_SLOTS_FUNCTION_DEFINITION;
  protected readonly schema = argsSchema;

  async execute(
    args: AssignDataSlotsArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<AssignDataSlotsData>> {
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
      logger.error('assign_data_slots: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('assign_data_slots: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages = buildDataSlotAssignmentPrompt(
      args.structure,
      args.existingSlots,
      args.orphanQuestionKeys
    );

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<DataSlotAssignmentOutput>;
    try {
      completion = await runStructuredCompletion<DataSlotAssignmentOutput>({
        provider,
        model,
        messages,
        maxTokens: ASSIGN_MAX_TOKENS,
        timeoutMs: ASSIGN_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateDataSlotAssignment(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((i) =>
              i.path.length > 0 ? i.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildDataSlotAssignmentRetryMessage(),
        onFinalFailure: () =>
          new Error(
            'Data-slot assignment response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('assign_data_slots: structured completion failed', {
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
      logger.error('assign_data_slots: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    return this.success({ placements: completion.value.placements });
  }
}
