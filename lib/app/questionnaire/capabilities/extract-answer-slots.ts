/**
 * Questionnaire answer-extractor capability (F4.2).
 *
 * A `BaseCapability` that turns one respondent message into typed answer values
 * for one or more slots — the active question plus any others the message also
 * answers (a *side-effect*). It runs a single **provider-agnostic** structured
 * LLM call via `runStructuredCompletion` (call → parse → retry-once-at-temp-0 →
 * cost-sum), validates the output against the F4.2 Zod contract, validates each
 * value against its slot's real type/config and normalises into version-agnostic
 * `AnswerSlotIntent`s, logs cost, and returns them. It does **not** persist — the
 * session/answer tables don't exist yet (F4.6), so the preview route returns the
 * intents and F4.6 will write them. Storage-agnostic and unit-testable by
 * `dispatch()` with a mocked provider.
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js
 * (enforced by ESLint). Provider/model resolution is read from the dispatch
 * context (the route supplies the answer-extractor agent's binding); when absent
 * it falls back to an empty binding, which `resolveAgentProviderAndModel` fills
 * from the system default — the same dynamic-resolution contract every
 * system-seeded agent uses.
 *
 * PII: the respondent's message, the transcript, and prior answers are personal
 * data, so `processesPii = true` and `redactProvenance()` is overridden — the
 * registry refuses to register a PII capability otherwise.
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
  EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG,
  EXTRACT_ANSWER_SLOTS_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import { QUESTION_TYPES } from '@/lib/app/questionnaire/types';
import {
  validateAnswerExtraction,
  type AnswerExtraction,
} from '@/lib/app/questionnaire/extraction/extraction-schema';
import {
  buildAnswerExtractionPrompt,
  buildAnswerExtractionRetryMessage,
} from '@/lib/app/questionnaire/extraction/extraction-prompt';
import { normalizeAnswerIntents } from '@/lib/app/questionnaire/extraction/answer-intents';
import type {
  AnswerSlotIntent,
  ExtractionContext,
  ExtractionSlotView,
} from '@/lib/app/questionnaire/extraction/types';

const SLUG = EXTRACT_ANSWER_SLOTS_CAPABILITY_SLUG;

/**
 * One respondent message answering a handful of slots is a small payload, far
 * smaller than a full ingest. Generous headroom for a reasoning model's internal
 * tokens while keeping the per-turn call snappy.
 */
const ANSWER_EXTRACTION_MAX_TOKENS = 4_000;

/**
 * A per-turn call must be snappy — a respondent is waiting. 30s covers a slow
 * model without hanging the conversation the way the 120s ingestion timeout would.
 */
const ANSWER_EXTRACTION_TIMEOUT_MS = 30_000;

/** Provenance preview cap (chars). The plan asks for a short, PII-safe preview. */
const PROVENANCE_PREVIEW_CAP = 200;

/**
 * Defensive ceiling on the candidate pool the route may pass. The route caps its
 * own input; this guards the capability when called directly (tests, CLI) so a
 * runaway list can't blow up the prompt.
 */
const MAX_CANDIDATE_SLOTS = 300;

/** A candidate slot as the route/caller supplies it (key-space; ids optional). */
const candidateSlotSchema = z.object({
  key: z.string().min(1),
  prompt: z.string(),
  type: z.enum(QUESTION_TYPES),
  typeConfig: z.unknown().optional(),
  guidelines: z.string().optional(),
  required: z.boolean().optional(),
  id: z.string().optional(),
  sectionId: z.string().optional(),
});

const argsSchema = z.object({
  /** The respondent's message to extract from (this turn). */
  userMessage: z.string().min(1),
  /** Key of the question being asked — must be one of `candidateSlots`. */
  activeQuestionKey: z.string().min(1),
  /** The active slot plus the version's unanswered slots. */
  candidateSlots: z.array(candidateSlotSchema).min(1).max(MAX_CANDIDATE_SLOTS),
  /** Already-answered state, so the extractor doesn't re-ask. */
  answered: z
    .array(
      z.object({ slotKey: z.string().min(1), confidence: z.number().min(0).max(1).nullable() })
    )
    .optional(),
  /** Recent transcript, oldest first. */
  recentMessages: z.array(z.string()).max(50).optional(),
  /** Stable session identity, threaded into cost-log metadata. */
  sessionId: z.string().optional(),
});

export type ExtractAnswerSlotsArgs = z.infer<typeof argsSchema>;

/** What the capability returns: the normalised answer-write intents for this turn. */
export interface ExtractAnswerSlotsData {
  intents: AnswerSlotIntent[];
  /**
   * How many of the model's reported answers the normaliser discarded (unknown
   * slot, value failed its type, duplicate). Surfaced so the preview route can
   * report it honestly — a non-zero count means the model produced more than
   * what's in `intents`.
   */
  droppedCount: number;
}

/**
 * Read the answer-extractor agent's resolvable binding from the dispatch context.
 * The preview route sets `entityContext.answerExtractorAgent` to the agent's
 * `{ provider, model, fallbackProviders }`; we validate defensively (never trust
 * the shape) and fall back to an empty binding so the capability still resolves
 * to the system default when called without it (tests, CLI).
 */
function readAnswerExtractorAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.answerExtractorAgent;
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

/** Map the validated args onto the pure `ExtractionContext` the core reads. */
function toExtractionContext(args: ExtractAnswerSlotsArgs): ExtractionContext {
  const candidateSlots: ExtractionSlotView[] = args.candidateSlots.map((s) => ({
    key: s.key,
    type: s.type,
    typeConfig: s.typeConfig ?? null,
    prompt: s.prompt,
    required: s.required ?? false,
    ...(s.id !== undefined ? { id: s.id } : {}),
    ...(s.sectionId !== undefined ? { sectionId: s.sectionId } : {}),
    ...(s.guidelines !== undefined ? { guidelines: s.guidelines } : {}),
  }));

  return {
    activeQuestionKey: args.activeQuestionKey,
    candidateSlots,
    answered: args.answered ?? [],
    userMessage: args.userMessage,
    sessionId: args.sessionId ?? `dispatch-${args.activeQuestionKey}`,
    ...(args.recentMessages ? { recentMessages: args.recentMessages } : {}),
  };
}

export class AppExtractAnswerSlotsCapability extends BaseCapability<
  ExtractAnswerSlotsArgs,
  ExtractAnswerSlotsData
> {
  readonly slug = SLUG;
  readonly processesPii = true;

  // Shared with the AiCapability seed so the class and the DB row can't drift.
  // Source of truth lives in constants.ts.
  readonly functionDefinition = EXTRACT_ANSWER_SLOTS_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  /**
   * Args carry the respondent's message + transcript + prior answers (all PII);
   * the result carries extracted values + source quotes that echo it. Persist
   * only what's safe for a durable audit row: structural keys/counts. The LLM
   * never sees this redacted form — only the provenance record does.
   */
  redactProvenance(
    args: ExtractAnswerSlotsArgs,
    result: CapabilityResult<ExtractAnswerSlotsData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      activeQuestionKey: args.activeQuestionKey,
      candidateSlotCount: args.candidateSlots.length,
      userMessage: redactedString('userMessage'),
      ...(args.recentMessages !== undefined
        ? { recentMessages: redactedString('recentMessages') }
        : {}),
      ...(args.answered !== undefined ? { answered: redactedString('answered') } : {}),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    };

    let preview: string;
    if (result.success && result.data) {
      const { intents } = result.data;
      // Counts only — never the values / source quotes, which reproduce PII.
      const provenanceCounts: Record<string, number> = {};
      for (const intent of intents) {
        provenanceCounts[intent.provenance] = (provenanceCounts[intent.provenance] ?? 0) + 1;
      }
      preview = JSON.stringify({
        success: true,
        data: {
          intentCount: intents.length,
          activeAnswerCount: intents.filter((i) => i.isActiveQuestion).length,
          sideEffectCount: intents.filter((i) => !i.isActiveQuestion).length,
          droppedCount: result.data.droppedCount,
          provenanceCounts,
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
    args: ExtractAnswerSlotsArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<ExtractAnswerSlotsData>> {
    // 1. Resolve the provider/model binding (provider-agnostic). Empty binding →
    //    system default, the same path system-seeded agents take. Per-turn work
    //    resolves the `chat` tier, not the heavier `reasoning` tier ingestion uses.
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readAnswerExtractorAgentBinding(context.entityContext),
        'chat'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('extract_answer_slots: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('extract_answer_slots: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    // 2. Build the prompt from the pure context.
    const extractionContext = toExtractionContext(args);
    const messages = buildAnswerExtractionPrompt(extractionContext);

    // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum). Capture the
    //    Zod issue paths of the most recent schema-invalid (but JSON-parseable)
    //    response so a failure can name WHICH fields were wrong. (As in the
    //    structure extractor: runStructuredCompletion fixes its retry message
    //    before the call, so the paths surface in the final error + logs only.)
    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<AnswerExtraction>;
    try {
      completion = await runStructuredCompletion<AnswerExtraction>({
        provider,
        model,
        messages,
        maxTokens: ANSWER_EXTRACTION_MAX_TOKENS,
        timeoutMs: ANSWER_EXTRACTION_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateAnswerExtraction(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildAnswerExtractionRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            'Answer-extraction response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('extract_answer_slots: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'extraction_failed');
    }

    // 4. Cost — fire-and-forget. An accounting write must never fail the turn.
    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: SLUG, sessionId: extractionContext.sessionId },
    }).catch((err) => {
      logger.error('extract_answer_slots: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // 5. Validate each value against its slot + normalise into intents.
    const { intents, dropped } = normalizeAnswerIntents(
      completion.value.answers,
      extractionContext
    );
    if (dropped.length > 0) {
      logger.info('extract_answer_slots: dropped incoherent/invalid answers', {
        agentId: context.agentId,
        droppedCount: dropped.length,
      });
    }

    return this.success({ intents, droppedCount: dropped.length });
  }
}
