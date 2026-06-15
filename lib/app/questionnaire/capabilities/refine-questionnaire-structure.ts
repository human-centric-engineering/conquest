/**
 * Refine-questionnaire-structure capability (the conversational-refine turn of
 * generative authoring).
 *
 * Takes the current generated structure plus a natural-language instruction
 * ("make it shorter", "add a section on pricing") and returns the FULL updated
 * structure plus a one-line summary of what changed. One provider-agnostic
 * structured LLM call (call → parse → retry-once-at-temp-0 → cost-sum), validated
 * against {@link refineStructureSchema}. It does **not** persist — the refine route
 * replaces the draft version's graph from the returned structure.
 *
 * Reuses the composer agent (`entityContext.composerAgent`) — refinement is the
 * same design skill as composition. `processesPii = true`: the structure echoes
 * the brief's context.
 */

import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { redactedString } from '@/lib/security/redact';
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

import {
  REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  REFINE_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities/extract-questionnaire-structure';
import {
  buildRefineStructurePrompt,
  buildComposeRetryMessage,
} from '@/lib/app/questionnaire/ingestion/compose-prompt';
import {
  composeStructureSchema,
  toExtractionData,
  validateRefineStructure,
  type RefineStructureOutput,
} from '@/lib/app/questionnaire/ingestion/compose-schema';

const SLUG = REFINE_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG;

const REFINE_MAX_TOKENS = 16_000;
const REFINE_TIMEOUT_MS = 120_000;
const PROVENANCE_PREVIEW_CAP = 200;

const argsSchema = z.object({
  /** The structure to refine — validated against the same contract the composer emits. */
  currentStructure: composeStructureSchema,
  /** The admin's plain-English refinement instruction for this turn. */
  instruction: z.string().min(1),
});

export type RefineQuestionnaireStructureArgs = z.infer<typeof argsSchema>;

export interface RefineQuestionnaireStructureData {
  /** The full updated structure, in the persistence-shaped form (empty change log). */
  structure: ExtractQuestionnaireStructureData;
  /** One-line, human-readable summary of what changed (shown in the refine chat). */
  summary: string;
}

function readComposerAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.composerAgent;
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

export class AppRefineQuestionnaireStructureCapability extends BaseCapability<
  RefineQuestionnaireStructureArgs,
  RefineQuestionnaireStructureData
> {
  readonly slug = SLUG;
  readonly processesPii = true;

  readonly functionDefinition = REFINE_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  redactProvenance(
    _args: RefineQuestionnaireStructureArgs,
    result: CapabilityResult<RefineQuestionnaireStructureData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      instruction: redactedString('instruction'),
      currentStructure: redactedString('currentStructure'),
    };

    let preview: string;
    if (result.success && result.data) {
      const data = result.data;
      preview = JSON.stringify({
        success: true,
        data: {
          sectionCount: data.structure.sections.length,
          questionCount: data.structure.questions.length,
        },
      });
    } else {
      preview = JSON.stringify(result);
    }
    if (preview.length > PROVENANCE_PREVIEW_CAP) {
      preview = preview.slice(0, PROVENANCE_PREVIEW_CAP - 1) + '…';
    }

    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: RefineQuestionnaireStructureArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<RefineQuestionnaireStructureData>> {
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readComposerAgentBinding(context.entityContext),
        'reasoning'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('refine_questionnaire_structure: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('refine_questionnaire_structure: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    const messages = buildRefineStructurePrompt(args.currentStructure, args.instruction);

    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<RefineStructureOutput>;
    try {
      completion = await runStructuredCompletion<RefineStructureOutput>({
        provider,
        model,
        messages,
        maxTokens: REFINE_MAX_TOKENS,
        timeoutMs: REFINE_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateRefineStructure(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildComposeRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            'Refine response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('refine_questionnaire_structure: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'refinement_failed');
    }

    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: SLUG },
    }).catch((err) => {
      logger.error('refine_questionnaire_structure: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    return this.success({
      structure: toExtractionData(completion.value.structure),
      summary: completion.value.summary,
    });
  }
}
