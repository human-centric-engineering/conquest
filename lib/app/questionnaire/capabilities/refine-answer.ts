/**
 * Questionnaire answer-refiner capability (F4.4).
 *
 * A `BaseCapability` that, given a respondent's already-captured answers and new
 * context (a clarifying message and/or a flagged contradiction), decides per slot
 * whether to **refine** (the value evolved → provenance becomes `refined`),
 * **overwrite** (a mistaken capture → provenance preserved), or **leave** it. It runs
 * a single **provider-agnostic** structured LLM call via `runStructuredCompletion`
 * (call → parse → retry-once-at-temp-0 → cost-sum), validates against the F4.4 Zod
 * contract, normalises into coherent {@link RefinementDecision}s (drop unknown/
 * unanswered slots, value-fails-type, no-ops; dedupe per slot; reuse F4.2 value
 * validation), logs cost, and returns the decisions.
 *
 * It returns **decisions only** — it persists nothing. The refine-answer route
 * applies each decision via the pure `applyRefinement` and writes it through the
 * `_lib/answer-slots.ts` seam, keeping this capability storage-agnostic and
 * unit-testable by `dispatch()` with a mocked provider.
 *
 * Boundary: lives under `lib/app/**`, so it imports no Prisma and no Next.js
 * (enforced by ESLint). Provider/model resolution is read from the dispatch context
 * (the route supplies the refiner agent's binding); when absent it falls back to an
 * empty binding, which `resolveAgentProviderAndModel` fills from the system default.
 *
 * PII: the respondent's answers (and the rationales echoing them) are personal data,
 * so `processesPii = true` and `redactProvenance()` is overridden to a counts-only
 * preview — the registry refuses to register a PII capability otherwise.
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
  REFINE_ANSWER_CAPABILITY_SLUG,
  REFINE_ANSWER_FUNCTION_DEFINITION,
} from '@/lib/app/questionnaire/constants';
import { ANSWER_PROVENANCES, QUESTION_TYPES } from '@/lib/app/questionnaire/types';
import {
  validateRefinement,
  type Refinement,
} from '@/lib/app/questionnaire/refinement/refinement-schema';
import {
  buildRefinementPrompt,
  buildRefinementRetryMessage,
} from '@/lib/app/questionnaire/refinement/refinement-prompt';
import {
  normalizeRefinementDecisions,
  summarizeRefinements,
} from '@/lib/app/questionnaire/refinement/refinement-logic';
import type {
  ExistingAnswerView,
  RefinementContext,
  RefinementDecision,
  RefinementSlotView,
} from '@/lib/app/questionnaire/refinement/types';

const SLUG = REFINE_ANSWER_CAPABILITY_SLUG;

/**
 * The existing answers for one pass are a small payload (a handful of slots +
 * values). Generous headroom for a model's internal tokens while keeping the call
 * snappy — the same ceiling as answer extraction and contradiction detection.
 */
const REFINEMENT_MAX_TOKENS = 4_000;

/** A refinement pass can run mid-conversation; 30s covers a slow model without hanging. */
const REFINEMENT_TIMEOUT_MS = 30_000;

/** Provenance preview cap (chars) — a short, PII-safe preview. */
const PROVENANCE_PREVIEW_CAP = 200;

/**
 * Ceilings on the input. Exported so the route can align its own body schema to the
 * same numbers — otherwise a request the route accepts but the capability rejects
 * fails *soft* mid-dispatch, surfacing a confusing empty result instead of a clean
 * 400. They also guard direct (test/CLI) callers from a runaway prompt.
 */
export const MAX_REFINEMENT_SLOTS = 300;
export const MAX_REFINEMENT_ANSWERS = 300;

/** A slot definition as the route/caller supplies it (key-space; ids optional). */
const slotSchema = z.object({
  key: z.string().min(1),
  prompt: z.string(),
  type: z.enum(QUESTION_TYPES),
  typeConfig: z.unknown().optional(),
  guidelines: z.string().optional(),
  required: z.boolean().optional(),
  id: z.string().optional(),
  sectionId: z.string().optional(),
});

/** One already-captured answer eligible for refinement. */
const existingAnswerSchema = z.object({
  slotKey: z.string().min(1),
  value: z.unknown(),
  provenance: z.enum(ANSWER_PROVENANCES),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  turnIndex: z.number().int().optional(),
});

const triggeringContradictionSchema = z.object({
  slotKeys: z.array(z.string()),
  explanation: z.string(),
  suggestedProbe: z.string().optional(),
});

const argsSchema = z.object({
  /** The version slot definitions to reason over. */
  slots: z.array(slotSchema).min(1).max(MAX_REFINEMENT_SLOTS),
  /** The already-captured answers eligible for refinement. */
  existingAnswers: z.array(existingAnswerSchema).min(1).max(MAX_REFINEMENT_ANSWERS),
  /** The respondent's new message that may warrant a refinement. */
  userMessage: z.string().optional(),
  /** The F4.3 finding that triggered this pass (the detection→refinement handoff). */
  triggeringContradiction: triggeringContradictionSchema.optional(),
  /** Recent transcript lines, oldest first, for disambiguation. */
  recentMessages: z.array(z.string()).optional(),
  /** Stable session identity, threaded into cost-log metadata. */
  sessionId: z.string().optional(),
});

export type RefineAnswerArgs = z.infer<typeof argsSchema>;

/** What the capability returns: the normalised refinement decisions for this pass. */
export interface RefineAnswerData {
  decisions: RefinementDecision[];
  /**
   * How many of the model's reported decisions the normaliser discarded
   * (unknown/unanswered slot, value-fails-type, no-op, duplicate). Surfaced so the
   * route can report it honestly.
   */
  droppedCount: number;
  /**
   * USD cost of this LLM call — surfaced so the live turn loop can sum a turn's true
   * spend for cost-cap enforcement (F6.3); mirrors the figure logged to `AiCostLog`.
   */
  costUsd: number;
}

/**
 * Read the refiner agent's resolvable binding from the dispatch context. The route
 * sets `entityContext.answerRefinerAgent` to the agent's `{ provider, model,
 * fallbackProviders }`; we validate defensively (never trust the shape) and fall back
 * to an empty binding so the capability still resolves to the system default when
 * called without it (tests, CLI).
 */
function readRefinerAgentBinding(
  entityContext: CapabilityContext['entityContext']
): ResolvableAgent {
  const raw = entityContext?.answerRefinerAgent;
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

/** Map the validated args onto the pure `RefinementContext` the core reads. */
function toRefinementContext(args: RefineAnswerArgs): RefinementContext {
  const slots: RefinementSlotView[] = args.slots.map((s) => ({
    key: s.key,
    type: s.type,
    typeConfig: s.typeConfig ?? null,
    prompt: s.prompt,
    required: s.required ?? false,
    ...(s.id !== undefined ? { id: s.id } : {}),
    ...(s.sectionId !== undefined ? { sectionId: s.sectionId } : {}),
    ...(s.guidelines !== undefined ? { guidelines: s.guidelines } : {}),
  }));

  const existingAnswers: ExistingAnswerView[] = args.existingAnswers.map((a) => ({
    slotKey: a.slotKey,
    value: a.value,
    provenance: a.provenance,
    ...(a.rationale !== undefined ? { rationale: a.rationale } : {}),
    ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
    ...(a.turnIndex !== undefined ? { turnIndex: a.turnIndex } : {}),
  }));

  return {
    slots,
    existingAnswers,
    // The route always supplies a real session id (`preview-<versionId>`); this
    // constant only labels direct/CLI dispatches in cost-log metadata.
    sessionId: args.sessionId ?? 'dispatch-refine',
    ...(args.userMessage !== undefined ? { userMessage: args.userMessage } : {}),
    ...(args.triggeringContradiction !== undefined
      ? { triggeringContradiction: args.triggeringContradiction }
      : {}),
    ...(args.recentMessages !== undefined ? { recentMessages: args.recentMessages } : {}),
  };
}

export class AppRefineAnswerCapability extends BaseCapability<RefineAnswerArgs, RefineAnswerData> {
  readonly slug = SLUG;
  readonly processesPii = true;

  // Shared with the AiCapability seed so the class and the DB row can't drift.
  // Source of truth lives in constants.ts.
  readonly functionDefinition = REFINE_ANSWER_FUNCTION_DEFINITION;

  protected readonly schema = argsSchema;

  /**
   * Args carry the respondent's answers (PII); the result carries rationales that
   * echo them. Persist only what's safe for a durable audit row: structural
   * keys/counts. The LLM never sees this redacted form — only the provenance record.
   */
  redactProvenance(
    args: RefineAnswerArgs,
    result: CapabilityResult<RefineAnswerData>
  ): { args: unknown; resultPreview: string } {
    const safeArgs = {
      slotCount: args.slots.length,
      answerCount: args.existingAnswers.length,
      hasUserMessage: args.userMessage !== undefined,
      hasContradiction: args.triggeringContradiction !== undefined,
      existingAnswers: redactedString('existingAnswers'),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    };

    let preview: string;
    if (result.success && result.data) {
      // Counts only — never values / rationales, which reproduce PII. The same
      // roll-up the route returns, so the two can't drift.
      preview = JSON.stringify({
        success: true,
        data: summarizeRefinements(result.data.decisions, result.data.droppedCount),
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
    args: RefineAnswerArgs,
    context: CapabilityContext
  ): Promise<CapabilityResult<RefineAnswerData>> {
    // 1. Resolve the provider/model binding (provider-agnostic). Empty binding →
    //    system default. Refinement is per-turn-ish work → the `chat` tier.
    let providerSlug: string;
    let model: string;
    try {
      const resolved = await resolveAgentProviderAndModel(
        readRefinerAgentBinding(context.entityContext),
        'chat'
      );
      providerSlug = resolved.providerSlug;
      model = resolved.model;
    } catch (err) {
      logger.error('refine_answer: no provider resolved', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'no_provider_configured');
    }

    let provider: Awaited<ReturnType<typeof getProvider>>;
    try {
      provider = await getProvider(providerSlug);
    } catch (err) {
      logger.error('refine_answer: provider unavailable', {
        agentId: context.agentId,
        providerSlug,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'provider_unavailable');
    }

    // 2. Build the prompt from the pure context.
    const refinementContext = toRefinementContext(args);
    const messages = buildRefinementPrompt(refinementContext);

    // 3. Structured call (parse → retry-once-at-temp-0 → cost-sum). Capture the Zod
    //    issue paths of the most recent schema-invalid (but JSON-parseable) response
    //    so a failure can name WHICH fields were wrong.
    let lastIssuePaths: string[] = [];
    let completion: StructuredCompletionResult<Refinement>;
    try {
      completion = await runStructuredCompletion<Refinement>({
        provider,
        model,
        messages,
        maxTokens: REFINEMENT_MAX_TOKENS,
        timeoutMs: REFINEMENT_TIMEOUT_MS,
        parse: (raw) =>
          tryParseJson(raw, (parsed) => {
            const validation = validateRefinement(parsed);
            if (validation.ok) return validation.value;
            lastIssuePaths = validation.issues.map((issue) =>
              issue.path.length > 0 ? issue.path.join('.') : '(root)'
            );
            return null;
          }),
        retryUserMessage: buildRefinementRetryMessage([]),
        onFinalFailure: () =>
          new Error(
            'Answer-refinement response was not valid against the schema after one retry' +
              (lastIssuePaths.length > 0 ? ` (invalid at: ${lastIssuePaths.join(', ')})` : '')
          ),
      });
    } catch (err) {
      logger.error('refine_answer: structured completion failed', {
        agentId: context.agentId,
        model,
        provider: providerSlug,
        issuePaths: lastIssuePaths,
        error: errorMessage(err),
      });
      return this.error(errorMessage(err), 'refinement_failed');
    }

    // 4. Cost — fire-and-forget. An accounting write must never fail the pass.
    void logCost({
      ...(context.agentId ? { agentId: context.agentId } : {}),
      operation: CostOperation.CHAT,
      model,
      provider: providerSlug,
      inputTokens: completion.tokenUsage.input,
      outputTokens: completion.tokenUsage.output,
      metadata: { capability: SLUG, appQuestionnaireSessionId: refinementContext.sessionId },
    }).catch((err) => {
      logger.error('refine_answer: logCost rejected', {
        agentId: context.agentId,
        error: errorMessage(err),
      });
    });

    // 5. Normalise into coherent decisions (drop unknown/unanswered/value-fails-type/
    //    no-op, filter leave, dedupe per slot).
    const { decisions, dropped } = normalizeRefinementDecisions(
      completion.value.refinements,
      refinementContext
    );
    if (dropped.length > 0) {
      logger.info('refine_answer: dropped incoherent decisions', {
        agentId: context.agentId,
        droppedCount: dropped.length,
      });
    }

    return this.success({ decisions, droppedCount: dropped.length, costUsd: completion.costUsd });
  }
}
