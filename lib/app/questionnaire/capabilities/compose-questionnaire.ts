/**
 * Compose-from-brief capability (generative authoring).
 *
 * A `BaseCapability` that turns a plain-English brief into the same opinionated,
 * structured questionnaire shape the extractor produces — sections, questions with
 * inferred types, and an inferred goal/audience — but from scratch, with no source
 * document and an **empty** editorial change log (nothing was edited; everything
 * was generated). It runs a single provider-agnostic structured LLM call via
 * `runStructuredCompletion` (call → parse → retry-once-at-temp-0 → cost-sum),
 * validates against the {@link composeStructureSchema} contract, logs cost, and
 * returns the result. It does **not** persist — the route writes the graph.
 *
 * This is the single-shot, API-accessible unit. The admin UI uses the streaming
 * orchestrator (`stream-compose.ts`) instead, which fans the same work out across
 * sections; both share these prompts and this schema.
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js.
 * Provider/model resolution reads `entityContext.composerAgent` (the route supplies
 * the composer agent's binding); when absent it falls back to the system default.
 *
 * PII: a brief can carry sensitive context (names, internal goals), so
 * `processesPii = true` and `redactProvenance()` is overridden.
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
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import {
  runStructuredCompletion,
  type StructuredCompletionResult,
} from '@/lib/orchestration/llm/structured-completion';

import {
  COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG,
  COMPOSE_QUESTIONNAIRE_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import { audienceShapeSchema } from '@/lib/app/questionnaire/ingestion/extraction-schema';
import type { ExtractQuestionnaireStructureData } from '@/lib/app/questionnaire/capabilities/extract-questionnaire-structure';
import {
  buildComposeFullPrompt,
  buildComposeRetryMessage,
} from '@/lib/app/questionnaire/ingestion/compose-prompt';
import {
  toExtractionData,
  validateComposeStructure,
  type ComposeStructure,
} from '@/lib/app/questionnaire/ingestion/compose-schema';
import type { AdminSuppliedMetadata } from '@/lib/app/questionnaire/ingestion/types';

const SLUG = COMPOSE_QUESTIONNAIRE_CAPABILITY_SLUG;

/** A full questionnaire is verbose; leave generous headroom (mirrors the extractor). */
const COMPOSE_MAX_TOKENS = 16_000;
/** Composition reads only the brief but emits the whole structure — a longer call. */
const COMPOSE_TIMEOUT_MS = 120_000;
/** Provenance preview cap (chars). */
const PROVENANCE_PREVIEW_CAP = 200;

const argsSchema = z.object({
  /** Plain-English description of the questionnaire to build. */
  brief: z.string().min(1),
  /** Admin-set goal — when present, the composer must use it verbatim, not infer. */
  adminProvidedGoal: z.string().optional(),
  /** Admin-set audience fields — suppressed per field. */
  adminProvidedAudience: audienceShapeSchema.optional(),
});

export type ComposeQuestionnaireArgs = z.infer<typeof argsSchema>;
export type ComposeQuestionnaireData = ExtractQuestionnaireStructureData;

/**
 * Read the composer agent's resolvable binding from the dispatch context. The
 * compose route sets `entityContext.composerAgent` to the agent's `{ provider,
 * model, fallbackProviders }`; validate defensively and fall back to an empty
 * binding so the capability still resolves to the system default when called
 * without it (tests, CLI). Mirrors the extractor's binding reader.
 */
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

/** Map the capability args' admin-provided fields onto `AdminSuppliedMetadata`. */
function toAdminSuppliedMetadata(
  args: ComposeQuestionnaireArgs
): AdminSuppliedMetadata | undefined {
  const meta: AdminSuppliedMetadata = {};
  if (args.adminProvidedGoal !== undefined) meta.goal = args.adminProvidedGoal;
  if (args.adminProvidedAudience !== undefined) meta.audience = args.adminProvidedAudience;
  return meta.goal !== undefined || meta.audience !== undefined ? meta : undefined;
}

export class AppComposeQuestionnaireCapability extends BaseCapability<
  ComposeQuestionnaireArgs,
  ComposeQuestionnaireData
> {
  readonly slug = SLUG;
  readonly processesPii = true;

  // Shared with the AiCapability seed so the class and the DB row can't drift.
  readonly functionDefinition = COMPOSE_QUESTIONNAIRE_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  /**
   * The brief (PII) and the inferred goal/audience can echo it. Persist only what's
   * safe for a durable audit row: structural counts. The LLM never sees this form.
   */
  redactProvenance(
    args: ComposeQuestionnaireArgs,
    result: CapabilityResult<ComposeQuestionnaireData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      brief: redactedString('brief'),
      ...(args.adminProvidedGoal !== undefined
        ? { adminProvidedGoal: redactedString('adminProvidedGoal') }
        : {}),
      ...(args.adminProvidedAudience !== undefined
        ? { adminProvidedAudience: redactedString('adminProvidedAudience') }
        : {}),
    };

    let preview: string;
    if (result.success && result.data) {
      const data = result.data;
      preview = JSON.stringify({
        success: true,
        data: {
          sectionCount: data.sections.length,
          questionCount: data.questions.length,
          hasInferredGoal: data.inferredGoal !== undefined,
          hasInferredAudience: data.inferredAudience !== undefined,
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
    args: ComposeQuestionnaireArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<ComposeQuestionnaireData>> {
    // 1. Resolve the provider/model binding (provider-agnostic).
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
      logger.error('compose_questionnaire: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('compose_questionnaire: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    // 2. Build the prompt (the admin's do-not-infer list flows through).
    const adminSupplied = toAdminSuppliedMetadata(args);
    const messages = buildComposeFullPrompt(args.brief, adminSupplied);

    // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum).
    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<ComposeStructure>;
    try {
      completion = await runStructuredCompletion<ComposeStructure>({
        provider,
        model,
        messages,
        maxTokens: COMPOSE_MAX_TOKENS,
        timeoutMs: COMPOSE_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateComposeStructure(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildComposeRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            'Compose response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('compose_questionnaire: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'composition_failed');
    }

    // 4. Cost — fire-and-forget.
    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: SLUG },
    }).catch((err) => {
      logger.error('compose_questionnaire: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    return this.success(toExtractionData(completion.value));
  }
}
