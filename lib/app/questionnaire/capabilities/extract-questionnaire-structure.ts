/**
 * Questionnaire extractor capability (F1.1 / PR3).
 *
 * A `BaseCapability` that turns parsed document text into the opinionated,
 * structured questionnaire shape the app persists — sections, questions, an
 * inferred goal/audience, and the per-decision editorial change log. It runs a
 * single **provider-agnostic** structured LLM call via `runStructuredCompletion`
 * (call → parse → retry-once-at-temp-0 → cost-sum), validates the output against
 * the PR2 Zod contract, normalises the change records, logs cost, and returns
 * the result. It does **not** persist — the route (PR4) writes the graph in one
 * transaction. This keeps the capability storage-agnostic and unit-testable by
 * `dispatch()` with a mocked provider.
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js
 * (enforced by ESLint). Provider/model resolution is read from the dispatch
 * context (the route supplies the extractor agent's binding); when absent it
 * falls back to an empty binding, which `resolveAgentProviderAndModel` fills
 * from the system default — the same dynamic-resolution contract every
 * system-seeded agent uses.
 *
 * PII: questionnaire documents carry personal data (names, contact details in
 * examples/answers), so `processesPii = true` and `redactProvenance()` is
 * overridden — the registry refuses to register a PII capability otherwise.
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
  EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG,
  EXTRACT_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION,
  MAX_INSTRUCTIONS_LENGTH,
} from '@/lib/app/questionnaire/constants';
import type { AudienceShape } from '@/lib/app/questionnaire/types';
import {
  audienceShapeSchema,
  validateExtraction,
  type ExtractedQuestion,
  type ExtractedSection,
  type ExtractionResult,
} from '@/lib/app/questionnaire/ingestion/extraction-schema';
import {
  buildExtractionPrompt,
  buildExtractionRetryMessage,
} from '@/lib/app/questionnaire/ingestion/extraction-prompt';
import { normalizeChangeRecords } from '@/lib/app/questionnaire/ingestion/change-records';
import type {
  AdminSuppliedMetadata,
  ChangeRecordIntent,
} from '@/lib/app/questionnaire/ingestion/types';

const SLUG = EXTRACT_QUESTIONNAIRE_STRUCTURE_CAPABILITY_SLUG;

/**
 * Reasoning models split this cap between internal reasoning and visible
 * output; a full questionnaire's sections + questions + change log is verbose,
 * so we leave generous headroom (mirrors `010-model-auditor`'s 16384 rationale).
 *
 * DEFERRED (F1.1, /code-review #1): extraction currently uses fixed sampling
 * params here, so the extractor agent's seeded `temperature`/`maxTokens` do not
 * flow through. Revisit once we exercise extraction against real documents later
 * in the plan — decide then whether operators should tune these per-agent (thread
 * the agent's values in) or whether fixed determinism is the right default (drop
 * the unused fields from the seed). Not actionable until we can see it in use.
 */
const EXTRACTION_MAX_TOKENS = 16_000;

/**
 * Extraction reads an entire document and emits a large structured payload —
 * far longer than the 10s evaluation default. 120s covers a multi-page doc on a
 * reasoning model without hanging the (synchronous, admin-triggered) request
 * indefinitely.
 */
const EXTRACTION_TIMEOUT_MS = 120_000;

/** Provenance preview cap (chars). The plan asks for a short, PII-safe preview. */
const PROVENANCE_PREVIEW_CAP = 200;

const argsSchema = z.object({
  /** Plain text the parser extracted from the upload (what the model reads). */
  documentText: z.string().min(1),
  fileName: z.string().min(1),
  mediaType: z.string().optional(),
  /** Admin-set goal — when present, the extractor must not infer it. */
  adminProvidedGoal: z.string().optional(),
  /** Admin-set audience fields — suppressed per field (admin-wins-per-field). */
  adminProvidedAudience: audienceShapeSchema.optional(),
  /**
   * Free-text extractor steering (does NOT suppress inference): e.g. which tab
   * holds the questions, or a term to genericise. Same cap as the route boundary
   * (shared constant) so the two validations can't drift.
   */
  adminProvidedInstructions: z.string().max(MAX_INSTRUCTIONS_LENGTH).optional(),
});

export type ExtractQuestionnaireStructureArgs = z.infer<typeof argsSchema>;

/**
 * What the capability returns to the route (PR4). Mirrors the PR2 extraction
 * contract but with the change log already normalised into version-agnostic
 * `ChangeRecordIntent[]` (coherence-checked + inference-suppressed). The route
 * attaches `versionId`/`targetEntityId` and applies the goal/audience merge.
 */
export interface ExtractQuestionnaireStructureData {
  sections: ExtractedSection[];
  questions: ExtractedQuestion[];
  inferredGoal?: string;
  inferredAudience?: Partial<AudienceShape>;
  changes: ChangeRecordIntent[];
}

/**
 * Read the extractor agent's resolvable binding from the dispatch context. The
 * ingestion route (PR4) sets `entityContext.extractorAgent` to the agent's
 * `{ provider, model, fallbackProviders }`; we validate defensively (never
 * trust the shape) and fall back to an empty binding so the capability still
 * resolves to the system default when called without it (tests, CLI).
 */
function readExtractorAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.extractorAgent;
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

/** Narrow an unknown thrown value to a log-safe message string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map the capability args' admin-provided fields onto `AdminSuppliedMetadata`. */
function toAdminSuppliedMetadata(
  args: ExtractQuestionnaireStructureArgs
): AdminSuppliedMetadata | undefined {
  const meta: AdminSuppliedMetadata = {};
  if (args.adminProvidedGoal !== undefined) meta.goal = args.adminProvidedGoal;
  if (args.adminProvidedAudience !== undefined) meta.audience = args.adminProvidedAudience;
  return meta.goal !== undefined || meta.audience !== undefined ? meta : undefined;
}

export class AppExtractQuestionnaireStructureCapability extends BaseCapability<
  ExtractQuestionnaireStructureArgs,
  ExtractQuestionnaireStructureData
> {
  readonly slug = SLUG;
  readonly processesPii = true;

  // Shared with the AiCapability seed (003) so the class and the DB row can't
  // drift. Source of truth lives in constants.ts.
  readonly functionDefinition = EXTRACT_QUESTIONNAIRE_STRUCTURE_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  /**
   * Args carry the full document text (PII) and the result carries source
   * quotes / before-after JSON that can echo it. Persist only what's safe for a
   * durable audit row: file metadata + structural counts. The LLM never sees
   * this redacted form — only the provenance record does.
   */
  redactProvenance(
    args: ExtractQuestionnaireStructureArgs,
    result: CapabilityResult<ExtractQuestionnaireStructureData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      fileName: args.fileName,
      ...(args.mediaType !== undefined ? { mediaType: args.mediaType } : {}),
      documentText: redactedString('documentText'),
      ...(args.adminProvidedGoal !== undefined
        ? { adminProvidedGoal: redactedString('adminProvidedGoal') }
        : {}),
      ...(args.adminProvidedAudience !== undefined
        ? { adminProvidedAudience: redactedString('adminProvidedAudience') }
        : {}),
      ...(args.adminProvidedInstructions !== undefined
        ? { adminProvidedInstructions: redactedString('adminProvidedInstructions') }
        : {}),
    };

    let preview: string;
    if (result.success && result.data) {
      const data = result.data;
      // Counts only — never the section titles / question prompts / source
      // quotes, which can reproduce document PII.
      preview = JSON.stringify({
        success: true,
        data: {
          sectionCount: data.sections.length,
          questionCount: data.questions.length,
          changeCount: data.changes.length,
          hasInferredGoal: data.inferredGoal !== undefined,
          hasInferredAudience: data.inferredAudience !== undefined,
        },
      });
    } else {
      // Error envelope is { success: false, error: { code, message } } — no PII.
      preview = JSON.stringify(result);
    }
    if (preview.length > PROVENANCE_PREVIEW_CAP) {
      preview = preview.slice(0, PROVENANCE_PREVIEW_CAP - 1) + '…';
    }

    return { args: safeArgs, resultPreview: preview };
  }

  async execute(
    args: ExtractQuestionnaireStructureArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<ExtractQuestionnaireStructureData>> {
    // 1. Resolve the provider/model binding (provider-agnostic). Empty binding
    //    → system default, the same path system-seeded agents take.
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readExtractorAgentBinding(context.entityContext),
        'reasoning'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('extract_questionnaire_structure: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('extract_questionnaire_structure: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    // 2. Build the prompt (the admin's do-not-infer list flows through to both
    //    the prompt and the change normaliser so they agree on "supplied").
    const adminSupplied = toAdminSuppliedMetadata(args);
    const messages = buildExtractionPrompt({
      documentText: args.documentText,
      fileName: args.fileName,
      ...(args.mediaType !== undefined ? { mediaType: args.mediaType } : {}),
      ...(adminSupplied !== undefined ? { adminSupplied } : {}),
      ...(args.adminProvidedInstructions !== undefined
        ? { adminInstructions: args.adminProvidedInstructions }
        : {}),
    });

    // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum). No silent
    //    fallback: a final parse/provider failure surfaces as an error result.
    //
    // Capture the Zod issue paths of the most recent schema-invalid (but
    // JSON-parseable) response so a failure can name WHICH fields were wrong,
    // instead of a bare "didn't validate". Naming the paths in the retry the
    // MODEL sees would need `runStructuredCompletion` to accept a dynamic retry
    // message (its `retryUserMessage` is a fixed string set before the call) —
    // that's a platform enhancement for upstream Sunrise, deliberately not
    // forked here. So we surface the paths in the final error + logs only.
    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<ExtractionResult>;
    try {
      completion = await runStructuredCompletion<ExtractionResult>({
        provider,
        model,
        messages,
        maxTokens: EXTRACTION_MAX_TOKENS,
        timeoutMs: EXTRACTION_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateExtraction(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        // Generic: lastIssuePaths is still empty here (the parse callback that
        // populates it runs later), and runStructuredCompletion fixes this
        // string before the first attempt — so it can't carry runtime issues.
        retryUserMessage: buildExtractionRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            'Extraction response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('extract_questionnaire_structure: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'extraction_failed');
    }

    // 4. Cost — fire-and-forget. An accounting write must never fail the
    //    extraction the admin is waiting on (logCost itself swallows DB errors,
    //    but a rejected promise still needs a catch).
    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: SLUG, fileName: args.fileName },
    }).catch((err) => {
      logger.error('extract_questionnaire_structure: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // 5. Normalise the editorial change log (coherence + admin-suppression).
    const { intents, dropped } = normalizeChangeRecords(completion.value.changes, adminSupplied);
    if (dropped.length > 0) {
      logger.info('extract_questionnaire_structure: dropped incoherent/suppressed changes', {
        agentId: context.agentId,
        droppedCount: dropped.length,
      });
    }

    const data: ExtractQuestionnaireStructureData = {
      sections: completion.value.sections,
      questions: completion.value.questions,
      changes: intents,
    };
    if (completion.value.inferredGoal !== undefined) {
      data.inferredGoal = completion.value.inferredGoal;
    }
    if (completion.value.inferredAudience !== undefined) {
      data.inferredAudience = completion.value.inferredAudience;
    }

    return this.success(data);
  }
}
